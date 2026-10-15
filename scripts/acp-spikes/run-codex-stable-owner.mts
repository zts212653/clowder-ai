import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stableOwner } from './codex-stable-owner.mjs';

if (process.env.CLOWDER_SPIKE_AUTHORIZED !== '1') throw new Error('Explicit bounded model-test authorization required');
const runId = process.env.CLOWDER_SPIKE_RUN_ID ?? 'stable-owner-3';
if (!/^[a-z0-9_-]{1,48}$/.test(runId)) throw new Error('Invalid isolated evidence run ID');
const dir = resolve('.cat-cafe/tmp/authorized-codex-20261014', runId);
await mkdir(dir);
const fixture = join(dir, 'fixture');
await mkdir(fixture);
await writeFile(join(fixture, 'sentinel.txt'), 'ACP-STABLE-OWNER-SENTINEL\n');
const trace = join(dir, 'tools.jsonl');
await writeFile(trace, '');
const profile = resolve('.cat-cafe/tmp/authorized-codex-20261013/home');
const bundle = resolve('.cat-cafe/tmp/acp-prototypes/codex-no-title/dist/index.js');
const nativePath =
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const sha = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
assert.equal(await sha(nativePath), 'a0f89acca07a511734cac7fddee26b2106fab68918717bc90df16104a0760a30');
const bindingRevision = createHash('sha256')
  .update(await readFile(join(profile, 'config.toml')))
  .update(await sha(bundle))
  .update(await sha(nativePath))
  .digest('hex');
const prompt =
  'Authorized isolated test. Call only fixture.read_fixture once with scenario A and delayMs 8000. Do not use any other files or tools. Await the real fixture result then reply briefly with its synthetic sentinel.';
const steer =
  'Keep the same one fixture tool running. After its real result include STABLE-OWNER-CONTROL. No extra tools or files.';
const mcp = [
  {
    name: 'fixture',
    command: process.execPath,
    args: [resolve('scripts/acp-spikes/readonly-fixture-mcp.mjs')],
    env: [
      { name: 'FIXTURE_DIR', value: fixture },
      { name: 'FIXTURE_TRACE', value: trace },
    ],
  },
];
const runnerSources = await Promise.all(
  ['run-codex-stable-owner.mts', 'codex-stable-owner.mts'].map(async (file) => {
    const source = `scripts/acp-spikes/${file}`;
    await writeFile(join(dir, file), await readFile(source));
    return { source, sha256: await sha(source) };
  }),
);
const owner = await stableOwner({
  bundle,
  cwd: fixture,
  syntheticPrompt: prompt,
  allowedSteer: steer,
  mcpServers: mcp,
  env: {
    CODEX_HOME: profile,
    CODEX_PATH: nativePath,
    CODEX_CONFIG: '{"hooks":{},"project_doc_max_bytes":0}',
    APP_SERVER_LOGS: join(dir, 'native'),
    CLOWDER_TRACE_REDACTIONS_FILE: join(profile, 'trace-redactions.json'),
    CLOWDER_CONTROL_JOURNAL: join(dir, 'journal'),
    CLOWDER_CONTROL_BINDING_REVISION: bindingRevision,
    CLOWDER_SPIKE_DISABLE_AUTO_TITLE: '1',
  },
});
const outcome: Record<string, unknown> = {
  evidenceKind: 'real_bridge_native_with_test_only_separate_HTTP_consumer_owner',
  production: false,
  hooksDisabled: true,
  shellDisabled: true,
  maxAcpPromptInvocations: 1,
  autoTitleSuppressed: true,
  providerModelCallCount: 'unknown; native turn may contain multiple model rounds',
  maxRuntimeMs: 90000,
  closeGraceMs: 3000,
  usdHardLimit: null,
  bundleHash: await sha(bundle),
  nativeHash: await sha(nativePath),
  bindingRevision,
  ownerPid: owner.pid,
  productionHttpConsumerUsed: false,
  productionOwnerImplemented: false,
};
outcome.runnerSources = runnerSources;
async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 70000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('stable_owner_timeout');
}
const started = Date.now();
const controller = new AbortController();
const limit = setTimeout(() => {
  outcome.budgetExhausted = true;
  controller.abort();
  void owner.close();
}, 90000);
const init = {
  protocolVersion: 1,
  clientInfo: { name: 'bounded-stable-owner-spike', version: '1' },
  clientCapabilities: {},
};
try {
  const firstInit = await owner.request('initialize', init);
  const session = await owner.request('session/new', { cwd: fixture, mcpServers: mcp });
  const sessionId = session.sessionId;
  await owner.request('session/set_mode', { sessionId, modeId: 'read-only' });
  const primary = owner
    .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, controller.signal)
    .catch((error) => {
      outcome.lostConsumerError = (error as Error).name;
    });
  await waitFor(async () => (await readFile(trace, 'utf8')).includes('"started"'));
  const snapshot = await owner.request('_clowder/v1/control', { action: 'snapshot', sessionId });
  const input = {
    action: 'steer',
    sessionId,
    nativeSessionId: sessionId,
    expectedTurnId: snapshot.nativeTurnId,
    bindingRevision,
    prompt: [{ type: 'text', text: steer }],
  };
  const before = await owner.request('_clowder/v1/control', { ...input, operationId: 'accepted-before-socket-drop' });
  const droppedAt = Date.now();
  controller.abort();
  await primary;
  const nextInit = await owner.request('initialize', init);
  assert.deepEqual(nextInit, firstInit);
  await assert.rejects(
    owner.request('initialize', { ...init, clientCapabilities: { fs: { readTextFile: true } } }),
    /409/,
  );
  const stillActive = await owner.request('_clowder/v1/control', { action: 'snapshot', sessionId });
  assert.equal(stillActive.nativeTurnId, snapshot.nativeTurnId);
  const after = await owner.request('_clowder/v1/control', { ...input, operationId: 'accepted-after-socket-drop' });
  assert.equal(after.nativeTurnId, snapshot.nativeTurnId);
  const repeated = await owner.request('_clowder/v1/control', { ...input, operationId: 'accepted-before-socket-drop' });
  assert.deepEqual(repeated, before);
  await waitFor(() => owner.frames.some((e) => !e.packet?.method && e.packet?.result?.stopReason === 'end_turn'));
  assert.equal(
    (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .filter((l) => JSON.parse(l).phase === 'completed').length,
    1,
  );
  await assert.rejects(
    owner.request('_clowder/v1/control', { ...input, operationId: 'stale-after-finish' }),
    /no active turn/,
  );
  Object.assign(outcome, {
    success: true,
    sessionId,
    nativeTurnId: snapshot.nativeTurnId,
    droppedAt,
    stillActive,
    before,
    after,
    repeated,
    activeTurnSurvivedConsumerDrop: true,
    completedFixtureCount: 1,
    ownerUnchanged: true,
    lateTargetRejected: true,
    durationMs: Date.now() - started,
  });
} catch (error) {
  outcome.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  clearTimeout(limit);
  controller.abort();
  await owner.close();
  await writeFile(join(dir, 'frames.json'), JSON.stringify(owner.frames));
  await writeFile(join(dir, 'result.json'), JSON.stringify(outcome, null, 2));
}
console.log(JSON.stringify(outcome));
