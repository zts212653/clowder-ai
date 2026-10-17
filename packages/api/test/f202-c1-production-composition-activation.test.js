/**
 * F202 Train C1 — Core cutover gate, part 2: production-composition wiring and config projection.
 *
 * WHY SEPARATE FROM f202-c1-im-cutover-wake-parity.test.js: that file pins the WAKE SEMANTICS
 * an authenticated `connector_binding` ingress must have, at the `createMessagingDomain(...)`
 * seam with hand-injected Host collaborators. That isolation is deliberate and still correct —
 * but on its own it is satisfiable by an implementation nothing in production ever composes.
 *
 * Binding authority/durability (gaps D/E) was dispositioned out of C1 to C2 on 2026-09-20:
 * both required a new public wire row, which C1 does not add. See plan §7.3 for the ruling
 * and the exact `7075c3aed` coordinates to recover those 13 cases. Per-gap source
 * coordinates for the surviving gaps A/B/C live in the plan §5.1.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { HostPluginConfigurationService } from '../dist/domains/plugin/manager/plugin-manager-configuration.js';
import {
  ingressDraft,
  productionComposition,
  SYNTHETIC_INSTANCE,
  THREAD_ID,
  waitForSpec,
} from './f202-c1-production-composition-helpers.js';
import {
  EXTERNAL_PACKAGE_DIGEST,
  EXTERNAL_PLUGIN_ID,
  externalManifest,
  FakePluginProcessAdapter,
} from './plugin-external-runtime-helpers.js';

const SYNTHETIC_SECRET = 'synthetic-feishu-secret-4f2a';

describe('F202 C1 Core cutover gate — production-composition activation prerequisites', () => {
  test('7/RED — the shipped composition wires Host wake and broadcast for authenticated ingress', async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'f202-c1-prod-wiring-'));
    const { runtime, wakes, broadcasts, participants } = await productionComposition(projectRoot);
    participants.push({ catId: 'opus', lastMessageAt: 2_000, messageCount: 3 });

    // Internal issuance is used HERE ON PURPOSE: this case isolates collaborator wiring.
    // Bootstrap reachability is a different gap, measured in the binding-durability file.
    const { handleId } = await runtime.messaging.issueConnectorBindingHandle({
      pluginInstanceId: SYNTHETIC_INSTANCE,
      threadId: THREAD_ID,
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: false },
      connectorId: 'feishu',
      externalChatId: 'oc-chat-9',
    });

    await runtime.messaging.send(
      { pluginInstanceId: SYNTHETIC_INSTANCE },
      ingressDraft(handleId, '@opus 看一下', 'prod-7'),
    );

    assert.equal(
      wakes.length,
      1,
      'C1 blocker: createDormantPluginRuntimeComposition (runtime-composition.ts:213) composes the ' +
        'messaging domain with { messageStore, redis } only, and MessagingDomainDeps declares no ' +
        'invokeTrigger/socketManager/threadStore. A wake proven only with hand-injected collaborators ' +
        'does not exist in the process that ships.',
    );
    assert.equal(wakes[0]?.catId, 'opus', 'the shipped composition must derive the target Host-side');
    assert.equal(broadcasts.length, 1, 'the shipped composition must broadcast the ingress exactly once');

    await runtime.shutdown('test');
  });

  test('10/RED — manifest-declared config/secret reaches the external stdio runtime', async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), 'f202-c1-config-projection-'));
    await mkdir(resolve(projectRoot, 'dist'), { recursive: true });
    await writeFile(resolve(projectRoot, 'dist/plugin.js'), '// fixture entrypoint\n', 'utf8');

    const base = externalManifest();
    const manifest = {
      ...base,
      // The package must REQUEST secret.read for the Host to be allowed to grant it; an
      // effective grant outside the manifest request is rejected at admission by design.
      features: base.features.map((feature) => ({
        ...feature,
        capabilities: [...feature.capabilities, 'secret.read'],
      })),
      configuration: [{ key: 'FEISHU_APP_SECRET', label: 'Feishu app secret', kind: 'secret', required: true }],
    };
    const packages = {
      async resolveInstalledPackage() {
        return {
          rootDir: projectRoot,
          manifest,
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    };
    const processes = new FakePluginProcessAdapter();
    const { runtime: composed } = await productionComposition(projectRoot, { processes, packages });

    const installed = await composed.inventory.installPackage({
      manifest,
      computedPackageDigest: EXTERNAL_PACKAGE_DIGEST,
      expectedPackageDigest: EXTERNAL_PACKAGE_DIGEST,
      packagePluginId: EXTERNAL_PLUGIN_ID,
      effectiveGrants: ['events.publish', 'secret.read'],
      signalSchemas: {
        'schemas/external.signal.v1.schema.json': {
          type: 'object',
          properties: { payload: { type: 'object' }, source: { type: 'object' } },
          required: ['payload', 'source'],
        },
      },
    });

    // Readiness is EARNED through the real configuration authority, never hand-flipped: a
    // fail-closed projection must refuse to start without a stored value, so manufacturing
    // configReadiness in the inventory would make this case green against a broken Host.
    const configuration = new HostPluginConfigurationService({ projectRoot, inventory: composed.inventoryStore });
    const before = await composed.inventoryStore.snapshot();
    const record = before.instances.find((i) => i.pluginInstanceId === installed.pluginInstanceId);
    await configuration.configure(EXTERNAL_PLUGIN_ID, installed.pluginInstanceId, {
      expectedRevision: record.configRevision ?? record.lifecycleRevision,
      updates: [{ key: 'FEISHU_APP_SECRET', value: SYNTHETIC_SECRET }],
    });
    await configuration.reconcile(EXTERNAL_PLUGIN_ID, installed.pluginInstanceId);

    const ready = await composed.inventoryStore.snapshot();
    const readyRecord = ready.instances.find((i) => i.pluginInstanceId === installed.pluginInstanceId);
    assert.equal(readyRecord.configReadiness, 'ready', 'the real authority must derive readiness from a stored value');

    // enable() only settles after a handshake the fixture process never completes; the spawn
    // spec — the subject of this case — is produced before that, so observe it directly.
    const enabling = composed.lifecycle
      .enable(installed.pluginInstanceId, readyRecord.lifecycleRevision)
      .catch(() => undefined);
    const spec = await waitForSpec(processes);

    const projected = Object.keys(spec.env ?? {}).filter((key) => !key.startsWith('CLOWDER_'));
    assert.deepEqual(
      projected,
      ['FEISHU_APP_SECRET'],
      'C1 blocker: external-runtime/supervisor.ts:191-201 spawns a verified stdio package with only ' +
        'the four CLOWDER_* protocol variables, so a migrated IM provider receives none of its ' +
        'manifest-declared config/secrets. The in-process module path already performs exactly this ' +
        'grant-checked projection; the stdio path — the ' +
        'one every migrated npm package uses — has no equivalent.',
    );
    assert.equal(
      spec.env.FEISHU_APP_SECRET,
      SYNTHETIC_SECRET,
      'the EXACT stored value must reach the runtime; asserting only the key lets an empty or ' +
        'placeholder projection pass while the provider still cannot authenticate',
    );

    await composed.shutdown('test');
    await enabling;
  });
});
