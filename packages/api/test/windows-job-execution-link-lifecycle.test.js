/**
 * #1838: a turn's link to its Windows provider host job lives exactly as long as it is needed. The
 * real invokeSingleCat links the turn to its first host before the provider is marked started; the
 * provider then runs through the real spawnCli seam inside that host. The turn removes its links and
 * owner records once its terminal and provider teardown are durable, and records teardown only after
 * every host job is verifiably closed, which also reaps a writer whose launcher already exited. A
 * turn whose teardown is unconfirmed keeps its link: that link is the stop proof the next API joins.
 *
 * The test process itself never adopts a job, as the API no longer does. No real model is called.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
const { spawnCli } = await import('../dist/utils/cli-spawn.js');

const skip = process.platform !== 'win32' ? 'Windows kernel jobs only' : false;
const root = mkdtempSync(join(tmpdir(), 'issue1838-link-lifecycle-'));
process.env.AUDIT_LOG_DIR = join(root, 'audit');
process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';
process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
const linksDir = join(root, 'data', 'windows-job-execution-links');
const jobsDir = join(root, 'data', 'windows-api-jobs');
const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The provider prints one event and leaves a detached writer, the broken PPID chain of #1838.
mkdirSync(join(root, 'fixture'), { recursive: true });
const writerScript = join(root, 'fixture', 'writer.cjs');
writeFileSync(writerScript, 'setInterval(() => {}, 1000);');
const providerScript = join(root, 'fixture', 'provider.cjs');
writeFileSync(
  providerScript,
  [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const writer = spawn(process.execPath, [${JSON.stringify(writerScript)}], { stdio: 'ignore', detached: true });`,
    'writer.unref();',
    `fs.writeFileSync(${JSON.stringify(join(root, 'fixture', 'writer.pid'))}, String(writer.pid));`,
    "process.stdout.write(JSON.stringify({ type: 'provider_ready' }) + '\\n');",
  ].join('\n'),
);

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
  // A covered service: its one provider spawn is spawnCli with the turn's own invocationId.
  const service = {
    windowsProviderHosts: true,
    async *invoke(_prompt, options) {
      linksWhileRunning = list(linksDir);
      for await (const _ of spawnCli({
        command: process.execPath,
        args: [providerScript],
        invocationId: options.invocationId,
      }));
      for (const event of events) yield { catId: 'codex', timestamp: Date.now(), ...event };
    },
  };
  const params = { catId: 'codex', service, prompt: 'test', userId: 'user-1', threadId: 'thread-1' };
  for await (const _ of invokeSingleCat(deps, { ...params, parentInvocationId: 'parent-1', isLastCat: true }));
  const writerPid = Number(readFileSync(join(root, 'fixture', 'writer.pid'), 'utf8'));
  return { record: await store.get(invocationId), linksWhileRunning, writerPid };
}

test('a turn records teardown only after its host job reaped the tree, then drops its evidence', { skip }, async () => {
  const { record, linksWhileRunning, writerPid } = await runTurn('child-settled', [
    { type: 'text', content: 'complete' },
    { type: 'done' },
  ]);
  assert.equal(linksWhileRunning.length, 1, 'the link exists before the provider runs');
  assert.ok(linksWhileRunning[0].endsWith('.child-settled.json'));
  assert.equal(record.status, 'succeeded');
  assert.equal(typeof record.providerTeardownAt, 'number');
  assert.equal(alive(writerPid), false, 'the detached writer died with its host job before teardown was recorded');
  assert.deepEqual(list(linksDir), [], 'the settled turn left no link behind');
  assert.deepEqual(list(jobsDir), [], 'nor an owner record');
});

test('a turn whose provider teardown is unconfirmed keeps its job link', { skip }, async () => {
  const { record, linksWhileRunning } = await runTurn('child-unconfirmed', [
    { type: 'status', providerTeardown: 'unconfirmed', content: 'stop not confirmed' },
  ]);
  assert.equal(linksWhileRunning.filter((name) => name.endsWith('.child-unconfirmed.json')).length, 1);
  assert.equal(record.status, 'running', 'no terminal is written without teardown proof');
  assert.equal(record.providerTeardownAt, undefined);
  assert.equal(
    list(linksDir).filter((name) => name.endsWith('.child-unconfirmed.json')).length,
    1,
    'the stop proof stays for the next API instance',
  );
  assert.equal(list(jobsDir).length, 1, 'and so does the owner record a restart needs to find the job');
});
