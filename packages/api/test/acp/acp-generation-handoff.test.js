import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { closeStaleAcpPools } from '../../dist/domains/cats/services/agents/providers/acp/acp-pool-registry.js';

const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((done) => setImmediate(done));

for (const mode of [
  'idle',
  'active',
  'pinned-before-acquire',
  'failed-close',
  'disposed-middle',
  'disposed-middle-failed',
  'stale-middle',
  'stale-middle-failed',
  'stale-active',
  'stale-active-failed',
]) {
  test(`factory replacement waits for actual writer exit (${mode})`, async (t) => {
    const pinned = mode === 'active' || mode === 'pinned-before-acquire' || mode.startsWith('stale-active');
    const failed = mode.includes('failed');
    const root = await mkdtemp(join(tmpdir(), 'acp-generation-handoff-'));
    const registry = new Map();
    const pools = [];
    const services = [];
    const closing = gate();
    const exited = gate();
    t.after(async () => {
      exited.resolve();
      const disposed = await Promise.allSettled(services.map((service) => service.disposeHostService()));
      const closed = await Promise.allSettled(pools.map((pool) => pool.closeAll()));
      await rm(root, { recursive: true, force: true });
      for (const result of [...disposed, ...closed]) {
        if (result.status === 'rejected') {
          assert.equal(failed, true);
          assert.match(result.reason.message, /writer exit unconfirmed/);
        }
      }
    });
    const create = async (idleTtlMs) => {
      const service = await createAcpServiceForConfig({
        projectRoot: root,
        bootstrapRoot: join(root, 'bootstrap'),
        profileId: 'pi',
        config: { id: 'pi', clientId: 'acp', defaultModel: '', mcpSupport: false },
        effectiveModel: '',
        acpConfig: { command: 'node', startupArgs: [], pool: { idleTtlMs } },
        poolRegistry: registry,
        log: { info() {}, warn() {} },
      });
      assert.ok(service);
      services.push(service);
      const pool = registry.get('pi');
      pools.push(pool);
      return { service, pool };
    };
    const first = await create(60000);
    first.pool.clientFactory = () => ({
      isAlive: true,
      isCwdIntact: true,
      async initialize() {},
      async close() {
        closing.resolve();
        await exited.promise;
        if (failed) throw new Error('writer exit unconfirmed');
        this.isAlive = false;
      },
    });
    const view = pinned ? first.service.forInvocation() : null;
    const key = { projectPath: root, providerProfile: 'pi' };
    let lease = mode === 'pinned-before-acquire' ? null : await first.pool.acquire(key);
    if (!pinned && lease) {
      lease.release();
      lease = null;
    }
    if (mode.startsWith('stale-active')) await closeStaleAcpPools(registry, new Set());
    const second = await create(61000);
    assert.notEqual(second.pool, first.pool, 'TTL changes the factory generation but not native storage scope');
    let disposal;
    if (mode.startsWith('disposed-middle')) disposal = second.service.disposeHostService();
    if (mode.startsWith('stale-middle')) disposal = closeStaleAcpPools(registry, new Set());
    void disposal?.catch(() => {});
    await tick();
    // Reuse B's exact signature after its disposal: a stale registry entry must not be admitted as live.
    const third = await create(disposal ? 61000 : 62000);
    let spawned = false;
    third.pool.clientFactory = () => {
      spawned = true;
      return {
        isAlive: true,
        isCwdIntact: true,
        async initialize() {},
        async close() {
          this.isAlive = false;
        },
      };
    };
    const replacement = third.pool.acquire(key, { sessionId: 'native-session' });
    try {
      if (pinned) {
        await tick();
        assert.equal(spawned, false, 'a prepared old invocation still owns its writer');
        lease ??= await first.pool.acquire(key);
        lease.release();
        const unpinned = view.releaseInvocation();
        await closing.promise;
        await tick();
        assert.equal(spawned, false, 'a close request is not actual writer exit');
        exited.resolve();
        if (failed) await assert.rejects(unpinned, /writer exit unconfirmed/);
        else await unpinned;
      } else {
        await closing.promise;
        await tick();
        assert.equal(spawned, false, 'the replacement must not spawn while the previous writer is alive');
        exited.resolve();
      }
      if (failed) {
        await assert.rejects(replacement, /writer exit unconfirmed/);
        assert.equal(spawned, false, 'unconfirmed writer retirement must fail closed');
        return;
      }
      const next = await replacement;
      assert.equal(spawned, true);
      next.release();
    } finally {
      lease?.release();
      exited.resolve();
      await view?.releaseInvocation();
      await replacement.then(
        (next) => next.release(),
        () => {},
      );
      await disposal?.catch((error) => {
        assert.equal(failed, true);
        assert.match(error.message, /writer exit unconfirmed/);
      });
    }
  });
}
