import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { type TestContext, test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { CompanionHostBridge } from '../src/domains/concierge/live/CompanionHostBridge.js';
import { companionCommandValidator } from '../src/domains/plugin/desktop-window-runtime/admission.js';
import { COMPANION_ARCHIVE_CONTRACTS } from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import type { DesktopWindowLaunch } from '../src/domains/plugin/desktop-window-runtime/types.js';
import { OFFICIAL_PLUGIN_CATALOG } from '../src/domains/plugin/official-catalog.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { MemoryMeetingIntakeStore } from '../src/domains/signal-intake/MeetingIntakeStore.js';
import { MemorySignalRouteStore } from '../src/domains/signal-intake/SignalRouteStore.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import {
  companionDecisionWireResponse,
  readCompanionDecisionProjection,
} from '../src/routes/companion-decision-read-service.js';
import { desktopWindowManifest, windowHtml } from './f317-window.fixture.js';
import { approval } from './growing/unified-attention-fixtures.js';
import { staticEditorFixture } from './plugin-static-editor.fixture.js';

async function fixture(
  t: TestContext,
  version: '0.1.0-alpha.13' | '0.1.0-alpha.14' | '0.1.0-alpha.15' | '0.1.0-alpha.19',
) {
  const contract =
    version === '0.1.0-alpha.15' || version === '0.1.0-alpha.19'
      ? '0.1.0-beta.24'
      : version === '0.1.0-alpha.14'
        ? '0.1.0-beta.23'
        : '0.1.0-beta.21';
  const f = await staticEditorFixture(
    { ...desktopWindowManifest(windowHtml, '1.3.0'), pluginId: 'official.companion', version },
    windowHtml,
  );
  const actualArchive =
    version === '0.1.0-alpha.19'
      ? process.env.F317_VERIFIED_SUBTITLE_RETURN_ARCHIVE
      : version === '0.1.0-alpha.15'
        ? process.env.F317_VERIFIED_UNIFIED_ARCHIVE
        : version === '0.1.0-alpha.14'
          ? process.env.F317_VERIFIED_MODERN_ARCHIVE
          : undefined;
  const archive = COMPANION_ARCHIVE_CONTRACTS.find((row) => row.version === version);
  assert.ok(archive);
  const entry = actualArchive
    ? {
        ...OFFICIAL_PLUGIN_CATALOG.find((row) => row.pluginId === 'official.companion')!,
        version,
        packageDigest: archive.packageDigest,
        archiveUrl: `https://registry.npmjs.org/@clowder-ai/companion/-/companion-${version}.tgz`,
      }
    : { ...f.entry, effectiveGrants: ['windows.create' as const] };
  const bytes = actualArchive ? await readFile(actualArchive) : f.bytes;
  const owner = 'modern-composition-owner';
  const priorOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = owner;
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: owner });
  const config = { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'composition-selected' };
  app.get('/api/concierge/config', async () => ({
    status: 'available',
    config,
    selectedCompanionStatus: 'available',
    companions: [{ catProfileId: config.dutyCatProfileId, displayName: 'selected', available: true }],
  }));
  let needsMeAvailable = true;
  app.get('/api/approval-hub/pending', async () => ({
    items: [{ ...approval('composition'), ownerUserId: owner }],
    coverage: { state: 'complete' },
  }));
  app.get('/api/entrusted-work/needs-me', async (_request, reply) =>
    needsMeAvailable
      ? { ownerReads: [], coverage: { state: 'complete' } }
      : reply.code(503).send({ error: 'fixture source unavailable' }),
  );
  app.get('/api/concierge/work/decisions', async (request, reply) => {
    const query = request.query as { view?: 'unified'; offset?: string; limit?: string };
    const result = companionDecisionWireResponse(
      await readCompanionDecisionProjection(app, owner, {
        offset: Number(query.offset ?? 0),
        limit: Number(query.limit ?? 20),
      }),
      query.view,
    );
    return reply.code(result.statusCode).send(result.body);
  });
  const messages = new MessageStore();
  const saved = messages.append({
    userId: owner,
    threadId: 'home',
    catId: null,
    content: 'preserved',
    mentions: [],
    timestamp: 1,
  });
  let launch: DesktopWindowLaunch | undefined;
  let closes = 0;
  let bridgeContract: string | undefined;
  let denyClose = false;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: messages,
    // Normal deterministic tests use an explicitly trusted fixture catalog. The
    // opt-in registry journey uses the production digest catalog without overrides.
    ...(actualArchive ? {} : { companionArchives: [{ version, packageDigest: f.entry.packageDigest, contract }] }),
    createCompanionBridge: (context) => {
      bridgeContract = context.companionContract;
      return new CompanionHostBridge({
        ...context,
        app,
        ownerUserId: owner,
        origin: 'http://localhost:5102',
        openConversation: async () => true,
      });
    },
    desktopExecutor: {
      open: async (spec) => {
        launch = spec;
        return {
          poll: async () => 'visible',
          show: async () => {},
          close: async () => {
            closes++;
            if (denyClose) throw new Error('physical cleanup not confirmed');
          },
        };
      },
    },
  });
  t.after(async () => {
    denyClose = false;
    await runtime.shutdown();
    await app.close();
    await f.cleanup();
    if (priorOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = priorOwner;
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [entry],
    fetchArchive: async () => bytes,
  });
  const installed = await installer.install(entry.catalogId, entry);
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  assert.ok(launch?.request);
  assert.equal(launch.companionContract, contract);
  assert.equal(bridgeContract, contract);
  assert.equal(companionCommandValidator(contract)({ kind: 'settings.read' }), version !== '0.1.0-alpha.13');
  return {
    runtime,
    actualArchive,
    launch,
    config,
    saved,
    messages,
    instanceId: installed.pluginInstanceId,
    closes: () => closes,
    denyClose: () => {
      denyClose = true;
    },
    failNeedsMe: () => {
      needsMeAvailable = false;
    },
  };
}

test('subtitle-return archive keeps beta.24 through installation and loads its verified return control', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.19');
  const request = f.launch.request;
  assert.ok(request);
  assert.equal((await request({ kind: 'settings.read' })).kind, 'settings');
  const decisions = await request({ kind: 'decisions.read', offset: 0, limit: 20 });
  assert.ok('version' in decisions && decisions.version === 1);
  assert.equal(decisions.status, 'available');
  assert.equal(f.closes(), 0, 'reading and loading do not end the window');
  if (f.actualArchive) {
    const response = await fetch(f.launch.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="transcript-return"[^>]*data-action="transcript-return"/);
    assert.match(html, /返回通话/);
    const snapshot = await f.runtime.inventoryStore.snapshot();
    const pkg = snapshot.packages.find(
      (row) => row.pluginId === 'official.companion' && row.version === '0.1.0-alpha.19',
    );
    const archive = COMPANION_ARCHIVE_CONTRACTS.find((row) => row.version === '0.1.0-alpha.19');
    assert.ok(pkg);
    assert.ok(archive);
    assert.equal(pkg.packageDigest, archive.packageDigest);
  }
});

test('the exact unified archive preserves the landed F310 full/partial truth through one selected ABI', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.15');
  const command = { kind: 'decisions.read', offset: 0, limit: 20 };
  const full = await f.launch.request!(command);
  assert.ok('version' in full && 'items' in full);
  assert.equal(full.version, 1);
  assert.equal(full.status, 'available');
  assert.equal(full.totalCount, 1);
  assert.deepEqual(full.items[0]!.navigation.targets, [], 'unanchored source does not grant a guessed destination');
  assert.equal(full.items[0]!.summary, 'Choose composition');
  for (const privateField of ['proposalId', 'sourceFeatureId', 'ownerUserId'])
    assert.equal(JSON.stringify(full).includes(privateField), false);
  f.failNeedsMe();
  const partial = await f.launch.request!(command);
  assert.ok('version' in partial && 'items' in partial);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.items.length, 1);
  assert.equal('totalCount' in partial, false);
  assert.equal((await f.launch.request!({ kind: 'settings.read' })).kind, 'settings');
});

test('modern archive selects one ABI through installation, Broker, Bridge and kernel; its disable receipt proves cleanup', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.14');
  const request = f.launch.request!;
  assert.equal((await request({ kind: 'settings.read' })).kind, 'settings');
  assert.equal((await request({ kind: 'companion.disable', pluginInstanceId: 'another' })).kind, 'error');
  assert.equal((await f.runtime.desktopWindows?.presence()) !== null, true);
  assert.deepEqual(await request({ kind: 'companion.disable' }), {
    kind: 'companion-lifecycle',
    action: 'disable',
    outcome: 'disabled',
  });
  assert.equal(f.closes(), 1);
  assert.equal(await f.runtime.desktopWindows?.presence(), null);
  const state = await f.runtime.inventoryStore.snapshot();
  assert.equal(state.instances.find((row) => row.pluginInstanceId === f.instanceId)?.activationState, 'disabled');
  assert.ok(
    state.packages.some((row) => row.pluginId === 'official.companion'),
    'disable preserves the installed archive',
  );
  assert.equal((await f.messages.getById(f.saved.id))?.content, 'preserved');
  assert.deepEqual(f.config, { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'composition-selected' });
  assert.equal((await request({ kind: 'settings.read' })).kind, 'error', 'old authority cannot read after disable');
});

test('legacy alpha.13 selects beta.21 throughout and cannot submit modern settings or disable commands', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.13');
  for (const command of [{ kind: 'settings.read' }, { kind: 'companion.disable' }])
    assert.deepEqual(await f.launch.request!(command), { kind: 'error', code: 'invalid_request' });
  assert.equal(f.closes(), 0);
  assert.ok(await f.runtime.desktopWindows?.presence());
});

test('modern disable never reports disabled if physical cleanup rejects', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.14');
  f.denyClose();
  assert.equal((await f.launch.request!({ kind: 'companion.disable' })).kind, 'error');
  assert.equal(f.closes(), 1);
});

test('an old disable request cannot adopt the lifecycle revision of a replacement window', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.14');
  const desktop = f.runtime.desktopWindows;
  assert.ok(desktop);
  const run = desktop.features.run.bind(desktop.features);
  let checks = 0;
  let replaced = false;
  t.mock.method(desktop.features, 'run', async (lease: string, work: Parameters<typeof run>[1]) => {
    const result = await run(lease, work);
    if (!replaced && ++checks === 2) {
      replaced = true;
      const current = (await f.runtime.inventoryStore.snapshot()).instances.find(
        (row) => row.pluginInstanceId === f.instanceId,
      );
      assert.ok(current);
      const stopped = await f.runtime.lifecycle.disable(f.instanceId, current.lifecycleRevision);
      await f.runtime.lifecycle.enable(f.instanceId, stopped.lifecycleRevision);
    }
    return result;
  });
  const stale = await f.launch.request!({ kind: 'companion.disable' });
  assert.equal(replaced, true, 'replacement occurs after the old lease check and before the lifecycle read');
  assert.equal(stale.kind, 'error');
  assert.ok(await desktop.presence(), 'the new window stays enabled');
  assert.equal(f.closes(), 1, 'only the external replacement closed the old body');
});

test('a rejected effect remains observed when its feature transaction fails after starting it', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.14');
  const desktop = f.runtime.desktopWindows;
  assert.ok(desktop);
  const run = desktop.features.run.bind(desktop.features);
  let refusedCommit = false;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  t.mock.method(f.runtime.lifecycle, 'disable', async () => {
    throw new Error('cleanup failed');
  });
  t.mock.method(desktop.features, 'run', async (lease: string, work: Parameters<typeof run>[1]) => {
    const result = await run(lease, work);
    if (result && typeof result === 'object' && 'completion' in result) {
      refusedCommit = true;
      throw new Error('feature transaction commit failed');
    }
    return result;
  });
  assert.equal((await f.launch.request!({ kind: 'companion.disable' })).kind, 'error');
  assert.equal(refusedCommit, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, [], 'an effect rejection must not escape after admission reports a different failure');
});
