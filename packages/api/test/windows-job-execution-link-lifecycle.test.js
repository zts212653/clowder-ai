/**
 * #1838: a turn's link to the API's Windows kernel job lives exactly as long as it is needed. It is
 * written before the provider starts, and the turn that owns it removes it once its terminal and
 * provider teardown are durable, so links never pile up until the next API start. A turn whose
 * teardown is unconfirmed keeps its link: that link is the stop proof the next API instance joins.
 *
 * This test process adopts its own job, as the API does at startup, and drives the real
 * invokeSingleCat with a deterministic provider; no real model is called.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
const { adoptWindowsApiJob } = await import('../dist/utils/windows-job-owner.js');

const skip = process.platform !== 'win32' ? 'Windows kernel jobs only' : false;
const root = mkdtempSync(join(tmpdir(), 'issue1838-link-lifecycle-'));
process.env.AUDIT_LOG_DIR = join(root, 'audit');
process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';
const adoption = skip ? null : await adoptWindowsApiJob({ dataDir: join(root, 'data') });
const linksDir = join(root, 'data', 'windows-job-execution-links');
const links = () => {
  try {
    return readdirSync(linksDir);
  } catch {
    return [];
  }
};

after(() => rmSync(root, { recursive: true, force: true }));

async function runTurn(invocationId, events) {
  const store = new InMemoryTurnExecutionStore();
  let linksWhileRunning;
  const deps = {
    registry: {
      create: async () => ({ invocationId, callbackToken: `token-${invocationId}` }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => root,
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
    turnExecutionStore: store,
  };
  const service = {
    async *invoke() {
      linksWhileRunning = links();
      for (const event of events) yield { catId: 'codex', timestamp: Date.now(), ...event };
    },
  };
  const params = { catId: 'codex', service, prompt: 'test', userId: 'user-1', threadId: 'thread-1' };
  for await (const _ of invokeSingleCat(deps, { ...params, parentInvocationId: 'parent-1', isLastCat: true }));
  return { record: await store.get(invocationId), linksWhileRunning };
}

test('a turn removes its job link once its terminal and teardown are durable', { skip }, async () => {
  assert.equal(adoption.adopted, true, `adoption failed: ${adoption.reason}`);
  const { record, linksWhileRunning } = await runTurn('child-settled', [
    { type: 'text', content: 'complete' },
    { type: 'done' },
  ]);
  assert.equal(linksWhileRunning.length, 1, 'the link exists before the provider runs');
  assert.ok(linksWhileRunning[0].endsWith('.child-settled.json'));
  assert.equal(record.status, 'succeeded');
  assert.equal(typeof record.providerTeardownAt, 'number');
  assert.deepEqual(links(), [], 'the settled turn left no link behind');
});

test('a turn whose provider teardown is unconfirmed keeps its job link', { skip }, async () => {
  const { record, linksWhileRunning } = await runTurn('child-unconfirmed', [
    { type: 'status', providerTeardown: 'unconfirmed', content: 'stop not confirmed' },
  ]);
  assert.equal(linksWhileRunning.filter((name) => name.endsWith('.child-unconfirmed.json')).length, 1);
  assert.equal(record.status, 'running', 'no terminal is written without teardown proof');
  assert.equal(record.providerTeardownAt, undefined);
  assert.deepEqual(
    links().filter((name) => name.endsWith('.child-unconfirmed.json')).length,
    1,
    'the stop proof stays for the next API instance',
  );
});
