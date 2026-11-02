import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { currentPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.js';
import { invokeDeclaredDirectTool } from '../src/domains/plugin/declared/declared-direct-tool-call.js';
import { FilePluginInventoryStore, MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { createPluginTaskWriteFence } from '../src/domains/plugin/host-surface/task/plugin-task-write-fence.js';

for (const kind of ['memory', 'file'] as const) {
  for (const revoked of [false, true]) {
    test(`${kind}: direct-tool Task write fence ${revoked ? 'refuses revocation' : 'commits without an inventory reentry'}`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'direct-task-fence-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const store =
        kind === 'memory'
          ? new MemoryPluginInventoryStore()
          : new FilePluginInventoryStore(join(root, 'inventory.json'));
      const pluginId = 'dev.clowder.task-fence';
      const packageDigest = `sha512-${createHash('sha512').update('fixture').digest('base64')}`;
      await store.transaction((tx) => {
        tx.packages.put({
          pluginId,
          packageDigest,
          version: '1.0.0',
          contractVersion: '0.1.0',
          packageState: 'installed',
          verifiedAt: 1,
          updatedAt: 1,
          signalSchemas: {},
          manifest: {
            pluginId,
            version: '1.0.0',
            contractVersion: '0.1.0',
            name: 'Fixture',
            features: [{ id: 'main', name: 'Main', resources: [] }],
            runtime: { transport: 'builtin' },
          },
        });
        tx.instances.put({
          pluginId,
          packageDigest,
          pluginInstanceId: 'instance',
          lifecycleState: 'installed',
          lifecycleRevision: 1,
          activationState: 'enabled',
          configReadiness: 'ready',
          runtimeState: 'healthy',
          installedAt: 1,
          updatedAt: 1,
        });
      });
      let inTransaction = false,
        forbiddenReads = 0,
        insideChecks = 0,
        valid = true;
      let captured: ReturnType<typeof currentPluginCallContext>;
      const assertInvocationCurrent = async () => {
        if (inTransaction) insideChecks++;
        if (!valid) throw new Error('Invocation revoked');
      };
      const binding = { pluginInstanceId: 'instance', packageDigest, lifetime: new AbortController() };
      const call = () =>
        invokeDeclaredDirectTool({
          binding,
          isCurrent: () => true,
          caller: {
            catId: 'codex-sol',
            threadId: 'thread',
            userId: 'owner',
            invocationId: 'inv',
            assertCurrent: assertInvocationCurrent,
            assertInvocationCurrent,
          },
          resolveAdmission: async () => {
            // Both production stores wait for the active transaction before snapshot.
            // Detect that illegal read before it can self-deadlock the test process.
            if (inTransaction) {
              forbiddenReads++;
              throw new Error('Inventory snapshot reentered its own transaction');
            }
            const snapshot = await store.snapshot();
            return { instance: snapshot.instances[0]!, packageRecord: snapshot.packages[0]! };
          },
          invoke: () =>
            store.transaction(async (tx) => {
              inTransaction = true;
              try {
                captured = currentPluginCallContext('instance');
                if (revoked) valid = false;
                await createPluginTaskWriteFence({ native: captured }).assertCurrent();
                tx.instances.put({ ...tx.instances.get('instance')!, updatedAt: 7 });
                return 'committed';
              } finally {
                inTransaction = false;
              }
            }),
        });
      if (revoked) await assert.rejects(call(), /revoked/);
      else assert.equal(await call(), 'committed');
      assert.equal(forbiddenReads, 0);
      assert.ok(insideChecks > 0, 'the transaction still checks the invoking turn');
      assert.equal((await store.snapshot()).instances[0]!.updatedAt, revoked ? 1 : 7);
      await assert.rejects(captured!.assertInvocationCurrent!(), /current/);
    });
  }
}
