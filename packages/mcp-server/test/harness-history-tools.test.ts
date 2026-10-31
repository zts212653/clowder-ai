import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANONICAL_TOOL_REGISTRY } from '../src/canonical-server-tools.js';

test('history has discoverable owner-specific read and publication actions with invocation-only writes', () => {
  for (const name of ['cat_cafe_get_harness_history', 'cat_cafe_publish_harness_history']) {
    const tool = CANONICAL_TOOL_REGISTRY.find((entry) => entry.name === name);
    assert.ok(tool, `missing canonical history entry: ${name}`);
    assert.deepEqual(tool.policy.runtimeProfiles, ['full']);
    for (const contract of ['Use when:', 'NOT for:', 'Output:', 'GOTCHA:'])
      assert.ok(tool.description.includes(contract));
  }
});

test('MCP uses the F314 callback API, forwards CAS/restore exactly, and rejects caller authority before HTTP', async () => {
  const { handleGetHarnessHistory, handlePublishHarnessHistory } = await import(
    '../src/tools/harness-history-tools.js'
  );
  const saved = Object.fromEntries(
    ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN'].map((key) => [key, process.env[key]]),
  );
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  try {
    process.env.CAT_CAFE_API_URL = 'http://localhost:3172';
    process.env.CAT_CAFE_INVOCATION_ID = 'fixture-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'fixture-token';
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({ revision: 3 });
    };
    const programId = 'evolution-program:' + '1'.repeat(32);
    await handleGetHarnessHistory({ programId });
    const command = {
      action: 'restore' as const,
      restoreRevision: 1,
      expectedRevision: 3,
      clientMessageId: 'restore-one',
      reason: '恢复完整旧稿',
    };
    await handlePublishHarnessHistory({ programId, command });
    assert.equal(
      new URL(calls[0].url).pathname,
      `/api/callbacks/harness-history/programs/${encodeURIComponent(programId)}`,
    );
    assert.equal(
      new URL(calls[1].url).pathname,
      `/api/callbacks/harness-history/programs/${encodeURIComponent(programId)}/publications`,
    );
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), command);
    assert.equal(new Headers(calls[1].init.headers).get('x-invocation-id'), 'fixture-invocation');
    assert.throws(() =>
      handlePublishHarnessHistory({ programId, command: { ...command, actorRef: 'cat:spoof' } } as never),
    );
    assert.throws(() =>
      handlePublishHarnessHistory({
        programId,
        command: { ...command, action: 'publish', sourceRevision: 'HEAD' },
      } as never),
    );
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
