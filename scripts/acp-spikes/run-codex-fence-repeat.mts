import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AcpClient } from '../../packages/api/src/domains/cats/services/agents/providers/acp/AcpClient.js';

if (process.env.CLOWDER_SPIKE_AUTHORIZED !== '1') throw new Error('Explicit bounded model-test authorization required');
const runId = process.env.CLOWDER_SPIKE_RUN_ID ?? 'fence-repeat-1';
if (!/^[a-z0-9_-]{1,48}$/.test(runId)) throw new Error('Invalid isolated evidence run ID');
const dir = resolve('.cat-cafe/tmp/authorized-codex-20261014', runId);
await mkdir(dir);
const cwd = join(dir, 'fixture');
await mkdir(cwd);
await writeFile(join(cwd, 'sentinel.txt'), 'ACP-CODEX-REPEATED-FENCE-SENTINEL\n');
const trace = join(dir, 'tools.jsonl');
await writeFile(trace, '');
const home = resolve('.cat-cafe/tmp/authorized-codex-20261013/home');
const bundle = resolve('.cat-cafe/tmp/acp-prototypes/codex-no-title/dist/index.js');
const nativePath =
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const nativeHash = await hash(nativePath);
assert.equal(nativeHash, 'a0f89acca07a511734cac7fddee26b2106fab68918717bc90df16104a0760a30');
const bundleHash = await hash(bundle);
assert.equal(bundleHash, '265a60c7a7f19b3bb2a080198a91b48884846f8c80121598b3d27f46aadc7649');
const bindingRevision = createHash('sha256')
  .update(await readFile(join(home, 'config.toml')))
  .update(bundleHash)
  .update(nativeHash)
  .digest('hex');
const source = 'scripts/acp-spikes/run-codex-fence-repeat.mts';
await writeFile(join(dir, 'run-codex-fence-repeat.mts'), await readFile(source));
const events: Array<{ t: number; notification: { method: string; params?: Record<string, unknown> } }> = [];
const controls: Array<Record<string, unknown>> = [];
const client = new AcpClient({
  command: process.execPath,
  args: [bundle],
  cwd,
  env: {
    CODEX_HOME: home,
    CODEX_PATH: nativePath,
    CODEX_CONFIG: '{"hooks":{},"project_doc_max_bytes":0}',
    APP_SERVER_LOGS: join(dir, 'native'),
    CLOWDER_TRACE_REDACTIONS_FILE: join(home, 'trace-redactions.json'),
    CLOWDER_CONTROL_JOURNAL: join(dir, 'journal'),
    CLOWDER_CONTROL_BINDING_REVISION: bindingRevision,
    CLOWDER_SPIKE_DISABLE_AUTO_TITLE: '1',
  },
  spawnFn(command, args, options) {
    const env = { ...options?.env };
    for (const key of Object.keys(env))
      if (
        key.startsWith('CODEX_') &&
        ![
          'CODEX_HOME',
          'CODEX_PATH',
          'CODEX_CONFIG',
          'CODEX_SANDBOX_NETWORK_DISABLED',
          'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY',
        ].includes(key)
      )
        delete env[key];
    return spawn(command, args, { ...options, env, windowsHide: true });
  },
  permissionHandler(request, respond) {
    const call = request.params?.toolCall as Record<string, unknown> | undefined;
    const raw = call?.rawInput as Record<string, unknown> | undefined;
    const input = (raw?.arguments ?? raw) as Record<string, unknown> | undefined;
    const allowed =
      String(call?.title ?? '').includes('read_fixture') &&
      ['A', 'B'].includes(String(input?.scenario)) &&
      input?.delayMs === 8000;
    const option = (request.params?.options as Array<{ kind: string; optionId: string }> | undefined)?.find(
      (o) => o.kind === 'allow_once',
    );
    respond(allowed && option ? { optionId: option.optionId } : { cancelled: true });
  },
});
const seam = client as unknown as {
  sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ result: Record<string, unknown> }>;
  notificationListeners: Array<(notification: { method: string; params?: Record<string, unknown> }) => void>;
};
seam.notificationListeners.push((notification) => events.push({ t: Date.now(), notification }));
const request = async (method: string, params: Record<string, unknown>) => {
  try {
    const reply = await seam.sendRequest(method, params, 15000);
    controls.push({ t: Date.now(), method, params, result: reply.result });
    return reply.result;
  } catch (error) {
    controls.push({ t: Date.now(), method, params, error: (error as Error).message });
    throw error;
  }
};
const tools = async () =>
  (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const started = Date.now();
const outcome: Record<string, unknown> = {
  evidenceKind: 'real_native_ACP_repeated_A_to_B_boundary',
  nativeVersion: '0.161.0',
  nativeHash,
  bundleHash,
  bindingRevision,
  bridgePin: '51f78d67e46c3a96ee8d8bf4e43fc917ab21c73e',
  runnerSources: [{ source, sha256: await hash(source) }],
  maxAcpPrompts: 4,
  maxRuntimeMs: 180000,
  autoTitleSuppressed: true,
  providerModelCallCount: 'unknown',
  usdHardLimit: null,
  production: false,
  hooksDisabled: true,
  projectInstructionsDisabled: true,
  readonlyFixtureOnly: true,
};
const cases: Array<Record<string, unknown>> = [];
const deadline = setTimeout(() => {
  outcome.budgetExhausted = true;
  void client.close();
}, 180000);
try {
  const init = await client.initialize();
  outcome.initialize = init;
  const { sessionId } = await client.newSession(cwd, [
    {
      name: 'fixture',
      command: process.execPath,
      args: [resolve('scripts/acp-spikes/readonly-fixture-mcp.mjs')],
      env: [
        { name: 'FIXTURE_DIR', value: cwd },
        { name: 'FIXTURE_TRACE', value: trace },
      ],
    },
  ]);
  outcome.sessionId = sessionId;
  await request('session/set_mode', { sessionId, modeId: 'read-only' });
  const snapshot = () => request('_clowder/v1/control', { action: 'snapshot', sessionId });
  const run = (scenario: 'A' | 'B') =>
    (async () => {
      for await (const _event of client.promptStream(
        sessionId,
        `Authorized isolated read-only test. Call only fixture.read_fixture exactly once with scenario ${scenario} and delayMs 8000. Await its actual result and report its synthetic sentinel briefly. No other tools or files.`,
        { timeoutMs: 90000, idleStallMs: 90000 },
      )) {
        /* Raw notifications are captured above. */
      }
    })();
  const waitStarted = async (count: number) => {
    const until = Date.now() + 70000;
    while (Date.now() < until) {
      if ((await tools()).filter((e) => e.phase === 'started').length >= count) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Fixture start deadline exceeded');
  };
  for (let index = 0; index < 2; index++) {
    const a = run('A');
    // Attach rejection immediately so the deadline cannot create an unhandled promise.
    void a.catch(() => {});
    await waitStarted(index * 2 + 1);
    const aId = (await snapshot()).nativeTurnId;
    assert.equal(typeof aId, 'string');
    assert.ok(
      events.some(
        (e) => e.notification.method === '_clowder/v1/turn_started' && e.notification.params?.nativeTurnId === aId,
      ),
    );
    const valid = {
      action: 'steer',
      sessionId,
      nativeSessionId: sessionId,
      bindingRevision,
      expectedTurnId: aId,
      operationId: `valid-A-${index}`,
      prompt: [
        {
          type: 'text',
          text: 'Keep the same single fixture running. Report only its synthetic sentinel. No extra tools or files.',
        },
      ],
    };
    const receipt = await request('_clowder/v1/control', valid);
    assert.equal(receipt.nativeTurnId, aId);
    assert.deepEqual(await request('_clowder/v1/control', valid), receipt);
    await a;
    const b = run('B');
    void b.catch(() => {});
    await waitStarted(index * 2 + 2);
    const bId = (await snapshot()).nativeTurnId;
    assert.equal(typeof bId, 'string');
    assert.notEqual(bId, aId);
    const rejectedAt = Date.now();
    await assert.rejects(
      request('_clowder/v1/control', { ...valid, operationId: `stale-A-while-B-${index}` }),
      /expected active turn id/,
    );
    assert.equal((await snapshot()).nativeTurnId, bId);
    await b;
    assert.equal((await tools()).filter((e) => e.phase === 'completed').length, index * 2 + 2);
    cases.push({
      index,
      turnA: aId,
      turnB: bId,
      validReceipt: receipt,
      repeatedReceiptEqual: true,
      staleARejectedAt: rejectedAt,
      activeBUnchanged: true,
      bothPromptsCompleted: true,
    });
  }
  assert.notEqual(outcome.budgetExhausted, true);
  Object.assign(outcome, { success: true, cases, durationMs: Date.now() - started });
} catch (error) {
  Object.assign(outcome, { error: (error as Error).message, cases, durationMs: Date.now() - started });
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await client.close();
  await writeFile(join(dir, 'events.json'), JSON.stringify(events));
  await writeFile(join(dir, 'controls.json'), JSON.stringify(controls));
  await writeFile(join(dir, 'result.json'), JSON.stringify(outcome, null, 2));
}
console.log(JSON.stringify(outcome));
