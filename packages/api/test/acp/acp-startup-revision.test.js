import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpProcessPool } from '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js';

test('ACP only reuses a carrier with the requested startup revision and keeps the native session resumable', async () => {
  let initialized = 0;
  const createClient = () => ({
    isAlive: true,
    isCwdIntact: true,
    async initialize() {
      initialized += 1;
    },
    async close() {},
  });
  const pool = new AcpProcessPool({ maxLiveProcesses: 1 }, { supportsMultiplexing: true }, createClient);
  const key = { projectPath: '/isolated', providerProfile: 'member-a' };
  const startup = (revision) => ({
    revision,
    createInitializedClient: async () => {
      const client = createClient();
      await client.initialize();
      return client;
    },
  });
  try {
    const original = await pool.acquire(key, { startup: startup('l0-v1') });
    pool.rememberSession(key, 'old-session', original);
    await assert.rejects(
      pool.acquire(key, { sessionId: 'old-session', startup: startup('l0-v2') }),
      /retry after the active turn finishes/,
    );
    await original.release();
    const warm = await pool.acquire(key, { sessionId: 'old-session', startup: startup('l0-v1') });
    assert.equal(warm.client, original.client);
    await warm.release();
    const updated = await pool.acquire(key, { sessionId: 'old-session', startup: startup('l0-v2') });
    assert.notEqual(updated.client, original.client);
    assert.equal(updated.canResumeRequestedSession, true);
    assert.equal(initialized, 2);
    await updated.release();
  } finally {
    await pool.closeAll();
  }
});
