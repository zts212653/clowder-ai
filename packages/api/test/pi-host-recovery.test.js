import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpClient } from '../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { AcpProcessPool } from '../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js';
import { AcpSessionBindingError } from '../dist/domains/cats/services/agents/providers/acp/active-session-cache.js';
import { PiRpcProcess } from '../dist/domains/cats/services/agents/providers/pi/pi-rpc-process.js';
import { piSessionLaunch } from '../dist/domains/cats/services/agents/providers/pi/pi-session-launch.js';
import { PiSessionStore } from '../dist/domains/cats/services/agents/providers/pi/pi-session-store.js';

const relay = fileURLToPath(new URL('./helpers/pi-bridge-test-relay.mjs', import.meta.url));
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'pi-host-recovery-'));
  const clients = [];
  const make = () => {
    const client = new AcpClient({ command: process.execPath, args: [relay, root], cwd: root });
    clients.push(client);
    return client;
  };
  try {
    await run({ root, make });
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
  }
}
const collect = async (service, prompt, options) => {
  const messages = [];
  for await (const message of service.invoke(prompt, options)) messages.push(message);
  return messages;
};
const serviceFor = (client, root) =>
  new AcpAgentService({
    catId: 'pi-recovery-test',
    projectRoot: root,
    mcpSupport: false,
    providerName: 'Pi',
    poolKey: {},
    pool: {
      async acquire() {
        return { client, release() {} };
      },
    },
  });

test('real ACP Host preserves a Pi load failure instead of silently starting a replacement', () =>
  fixture(async ({ root, make }) => {
    const client = make();
    await client.initialize();
    await assert.rejects(client.loadSession('old-native-id', root, []), AcpSessionBindingError);
    const messages = await collect(serviceFor(client, root), 'continue', {
      workingDirectory: root,
      sessionId: 'old-native-id',
    });
    assert.equal(messages.find((m) => m.type === 'error')?.errorCode, 'prompt_failure');
    assert.equal(
      messages.some((m) => m.type === 'session_init'),
      false,
    );
    assert.equal(existsSync(join(root, 'seen-history.json')), false, 'no replacement prompt reaches native Pi');
  }));

test('real ACP Host classifies empty turns, recovers final text, accepts tool-only and keeps RPC errors', () =>
  fixture(async ({ root, make }) => {
    const client = make();
    await client.initialize();
    const service = serviceFor(client, root);
    for (const prompt of ['empty', 'empty-string', 'thinking-only']) {
      const messages = await collect(service, prompt, { workingDirectory: root });
      assert.equal(messages.find((m) => m.type === 'error')?.errorCode, 'empty_response');
    }
    for (const prompt of ['empty-delta-final', 'tool-only']) {
      const messages = await collect(service, prompt, { workingDirectory: root });
      assert.equal(
        messages.some((m) => m.type === 'error'),
        false,
      );
      if (prompt === 'empty-delta-final')
        assert.ok(messages.some((m) => m.type === 'text' && /Recovered final text/.test(m.content)));
    }
    const rejected = await collect(service, 'rejected', { workingDirectory: root });
    const failure = rejected.find((m) => m.type === 'error');
    assert.equal(failure.errorCode, 'prompt_failure');
    assert.match(failure.error, /model is unavailable/);
    assert.doesNotMatch(failure.error, /secret-fixture-token/);
  }));

test('actual ACP pool evicts the bridge and restores the same Pi history in a new process', () =>
  fixture(async ({ root, make }) => {
    const pool = new AcpProcessPool(
      { maxLiveProcesses: 1, idleTtlMs: 30, healthCheckIntervalMs: 30000 },
      { command: process.execPath, startupArgs: [relay, root], supportsMultiplexing: true },
      make,
    );
    const key = { projectPath: root, providerProfile: 'pi-test' };
    try {
      const first = await pool.acquire(key);
      const id = (await first.client.newSession(root, [])).sessionId;
      await first.client.promptCollect(id, 'remember CEDAR1704');
      pool.rememberSession(key, id, first);
      const pid = first.client.pid;
      first.release();
      const until = Date.now() + 4000;
      while (first.client.isAlive && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      assert.equal(first.client.isAlive, false, 'the real idle timer evicted the previous bridge');
      const second = await pool.acquire(key, { sessionId: id });
      assert.notEqual(second.client.pid, pid);
      const loaded = await second.client.loadSession(id, root, []);
      assert.equal(loaded.sessionId, id);
      await second.client.promptCollect(id, 'recall');
      assert.match(JSON.parse(readFileSync(join(root, 'seen-history.json'), 'utf8')).previous, /CEDAR1704/);
      second.release();
    } finally {
      await pool.closeAll();
    }
  }));

test('a native writer without bridge state blocks recovery until the actual writer exits', () =>
  fixture(async ({ root, make }) => {
    const first = make();
    await first.initialize();
    const id = (await first.newSession(root, [])).sessionId;
    await first.promptCollect(id, 'persist');
    await first.close();
    const slot = new PiSessionStore({ root, scope: 'd'.repeat(64) }).load(id, root, []);
    const fake = fileURLToPath(new URL('./helpers/pi-rpc-fixture.mjs', import.meta.url));
    const launch = piSessionLaunch(
      process.execPath,
      [fake, root, '--mode', 'rpc', '--session', slot.file, '--session-dir', slot.directory],
      slot,
    );
    // A real production runner held outside every Bridge Map models a surviving/orphaned writer.
    const native = new PiRpcProcess(launch.command, launch.args, root);
    try {
      assert.equal((await native.request('get_state')).sessionId, id);
      const second = make();
      await second.initialize();
      await assert.rejects(second.loadSession(id, root, []), /写者|占用/);
      await native.close();
      assert.equal((await second.loadSession(id, root, [])).sessionId, id);
    } finally {
      await native.close();
    }
  }));
