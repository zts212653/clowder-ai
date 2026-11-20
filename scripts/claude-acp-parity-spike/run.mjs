import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadBaselineLogic, nativePath, prepareEnvironment, sha, upstream } from './environment.mjs';
import { acpTransport, directTransport } from './transports.mjs';

if (process.env.CLOWDER_SPIKE_AUTHORIZED !== '1') throw new Error('Bounded live-test authorization required');
const [variant, runId] = process.argv.slice(2);
const hooksOnly = process.argv.includes('--hooks-only');
assert(['sdk-original', 'sdk-matching', 'acp'].includes(variant));
const state = await prepareEnvironment(runId);
const logic = await loadBaselineLogic(state.dir);
const events = [],
  consumed = new Map(),
  cases = {};
let sequence = 0;
const record = (entry) => {
  const event = state.redact({ sequence: ++sequence, t: Date.now(), ...entry });
  events.push(event);
  appendFileSync(join(state.dir, 'event-stream.jsonl'), `${JSON.stringify(event)}\n`);
  if (entry.kind === 'native')
    for (const id of logic.consumedClientInputIds(entry.raw)) {
      if (typeof id === 'string' && !consumed.has(id)) {
        consumed.set(id, { t: event.t, type: entry.raw.type, subtype: entry.raw.subtype, sequence: event.sequence });
      }
    }
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (predicate, label, timeout = 100000) => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error(`Timeout: ${label}`);
    await sleep(100);
  }
};
const toolEvents = async () => {
  try {
    return (await readFile(join(state.dir, 'tools.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
};
const nativeAfter = (t) => events.filter((event) => event.kind === 'native' && event.t >= t);
const idleAfter = (t) =>
  nativeAfter(t).some(
    (event) =>
      event.raw.type === 'system' && event.raw.subtype === 'session_state_changed' && event.raw.state === 'idle',
  );
const outputs = (t) =>
  nativeAfter(t)
    .filter((event) => event.raw.type === 'result')
    .map((event) => String(event.raw.result ?? ''))
    .join('\n');
const completedAndIdle = (id, t) => {
  const result = nativeAfter(t).find(
    (event) =>
      event.raw.type === 'result' && (event.raw.user_message_uuids?.includes(id) || event.raw.user_message_uuid === id),
  );
  return result && idleAfter(result.t);
};
const contextToken = `COMPACT-PROOF-${randomUUID()}`;
const handleHook = async ({ input }) => {
  const hook = input.hook_event_name;
  record({ kind: 'hostHookStarted', hook, source: input.source, trigger: input.trigger });
  const start = Date.now();
  await sleep(1500);
  assert.equal(
    nativeAfter(start).some((event) => event.raw.type === 'system' && event.raw.subtype === 'compact_boundary'),
    false,
    'native compact boundary must not precede the synchronous Host callback result',
  );
  record({ kind: 'hostHookReplied', hook });
  return hook === 'SessionStart'
    ? { additionalContext: `The verification token supplied only through this compact hook is ${contextToken}.` }
    : {};
};
const manifest = {
  variant,
  runId,
  baseline: '5941b402ed273eb9f3e6e1c0d5ee4cf3839c71dd',
  production: false,
  scenario: hooksOnly ? 'hooks-only' : 'combined',
  startedAt: new Date().toISOString(),
  model: state.model,
  nativePath,
  nativeSha256: await sha(nativePath),
  bridgeSourceSha256: await sha(join(upstream, 'src/acp-agent.ts')),
  bridgeCompiledSha256: await sha(join(upstream, 'dist/acp-agent.js')),
  predicateSourceSha256: logic.sourceSha256,
  sources: await Promise.all(
    ['run.mjs', 'transports.mjs', 'environment.mjs', 'bridge-extension.ts', 'fixture.mjs'].map(async (file) => ({
      file,
      sha256: await sha(`scripts/claude-acp-parity-spike/${file}`),
    })),
  ),
};
await writeFile(join(state.dir, 'manifest-before.json'), JSON.stringify(manifest, null, 2));
let transport;
const deadline = setTimeout(() => {
  record({ kind: 'deadline' });
  void transport?.close();
}, 300000);
try {
  console.log(JSON.stringify({ stage: 'starting', variant, runId }));
  transport = await (variant === 'acp'
    ? acpTransport(state, record, handleHook)
    : directTransport(state, variant, record, handleHook));
  manifest.sdk = transport.sdk;
  if (transport.probe) {
    let status = await transport.probe();
    await waitFor(
      async () => {
        status = await transport.probe();
        return status.every((entry) => entry.status !== 'pending');
      },
      'MCP preflight',
      30000,
    );
    record({ kind: 'mcpPreflight', status });
    assert(
      status.some((entry) => entry.name === 'fixture' && entry.status === 'connected'),
      'Fixture must connect before a model prompt',
    );
  }
  if (!hooksOnly) {
    const appendStart = Date.now();
    const primary = await transport.input(
      'Call mcp__fixture__wait exactly once with phase="append" and delayMs=8000. Wait for its result, then reply briefly.',
    );
    await waitFor(
      async () => (await toolEvents()).some((event) => event.event === 'started' && event.phase === 'append'),
      'append tool started',
    );
    const appendToken = `APPEND-PROOF-${randomUUID()}`;
    const append = await transport.input(
      `Additional instruction: include the exact token ${appendToken} in your next final reply. Do not stop the running tool.`,
    );
    const acceptedAt = Date.now();
    assert.equal(consumed.has(append), false, 'send acknowledgement is not consumption');
    await waitFor(
      () => consumed.has(append) && completedAndIdle(append, appendStart),
      'append consumption and native idle',
    );
    assert(outputs(appendStart).includes(appendToken), 'model must use appended input');
    cases.append = {
      primary,
      inputId: append,
      acceptedAt,
      consumed: consumed.get(append),
      toolEvents: await toolEvents(),
      success: true,
    };
    console.log(JSON.stringify({ stage: 'append-passed', variant }));
    const steerStart = Date.now();
    await transport.input(
      'Call mcp__fixture__wait exactly once with phase="steer" and delayMs=8000. Wait for its result, then reply briefly.',
    );
    await waitFor(
      async () => (await toolEvents()).some((event) => event.event === 'started' && event.phase === 'steer'),
      'steer tool started',
    );
    const steerToken = `STEER-PROOF-${randomUUID()}`;
    const steered = await transport.input(`Change direction now. Reply with the exact token ${steerToken}.`, 'steer');
    await waitFor(() => consumed.has(steered) && completedAndIdle(steered, steerStart), 'steer consumption and idle');
    assert(outputs(steerStart).includes(steerToken), 'model must use forced input');
    cases.steer = { inputId: steered, consumed: consumed.get(steered), success: true };
    console.log(JSON.stringify({ stage: 'steer-passed', variant }));
  } else {
    const primerStart = Date.now();
    const primer = await transport.input('This is an isolated compaction test. Reply READY. Do not use tools.');
    await waitFor(() => consumed.has(primer) && completedAndIdle(primer, primerStart), 'compaction primer');
  }
  const compactStart = Date.now();
  const compactInput = await transport.input('/compact');
  await waitFor(
    () =>
      events.some((event) => event.kind === 'hostHookReplied' && event.hook === 'SessionStart') &&
      idleAfter(compactStart),
    'real native compact hooks and idle',
    120000,
  );
  assert.equal(consumed.has(compactInput), false, 'local compact command is not a model read receipt');
  const afterCompact = Date.now();
  const follow = await transport.input(
    'Reply with the exact verification token provided by the compact SessionStart hook. Do not use tools.',
  );
  await waitFor(() => consumed.has(follow) && completedAndIdle(follow, afterCompact), 'post-compact reply');
  assert(outputs(afterCompact).includes(contextToken), 'additionalContext must reach the actual model');
  const hooks = events.filter((event) => event.kind.startsWith('hostHook'));
  assert.deepEqual(
    hooks.map((event) => [event.kind, event.hook]),
    [
      ['hostHookStarted', 'PreCompact'],
      ['hostHookReplied', 'PreCompact'],
      ['hostHookStarted', 'SessionStart'],
      ['hostHookReplied', 'SessionStart'],
    ],
  );
  const boundary = nativeAfter(compactStart).find(
    (event) => event.raw.type === 'system' && event.raw.subtype === 'compact_boundary',
  );
  assert(boundary && boundary.t >= hooks.at(-1).t, 'native boundary follows both synchronous Host replies');
  cases.compaction = { hooks, compactInput, follow, tokenObserved: true, success: true };
  console.log(JSON.stringify({ stage: 'hooks-passed', variant }));
  manifest.success = true;
} catch (error) {
  manifest.success = false;
  manifest.error = String(error);
  console.log(JSON.stringify({ stage: 'failed', variant, error: String(error) }));
} finally {
  clearTimeout(deadline);
  await transport?.close();
  await sleep(2500);
  manifest.finishedAt = new Date().toISOString();
  manifest.cases = cases;
  manifest.consumptionReceipts = [...consumed].map(([inputId, evidence]) => ({ inputId, ...evidence }));
  await writeFile(join(state.dir, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(join(state.dir, 'result.json'), JSON.stringify(manifest, null, 2));
  console.log(
    JSON.stringify({ stage: 'finished', variant, success: manifest.success, result: join(state.dir, 'result.json') }),
  );
}
if (!manifest.success) process.exitCode = 1;
