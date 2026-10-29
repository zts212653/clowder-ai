import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isConfirmedNativeAuthFailure } from '../dist/domains/cats/services/agents/invocation/native-auth-continuation.js';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { projectAgyNativeTurn } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js';
import { summarizeAgyStreamJsonTurn } from '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js';

// Source100's ordered shape, synthetic public fixture text, no private transcript dependency.
const fixture = () =>
  readFileSync(new URL('./fixtures/agy-stream-json/recovered-split-response.ndjson', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
const policyError =
  'Your previous response was blocked by content safety filters\nOutput retries exhausted after 4 attempts';
const session = 'split-response-session';
const model = 'gemini-3.8-flash-high';
const extraStep = (step_index, step_type, fields = {}) => ({
  event: 'step_update',
  step_update: { conversation_id: session, step_index, step_type, state: 'DONE', ...fields },
});
function project(events, { transportError = null, cancelled = false } = {}) {
  const turn = summarizeAgyStreamJsonTurn(events.map(JSON.stringify));
  const metadata = { provider: 'google', model };
  const messages = projectAgyNativeTurn('gemini38', metadata, { sessionId: session, turn, transportError }, cancelled);
  return { turn, metadata, messages };
}

async function serviceRun(events, { internal = false, signal, beforeResult } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-split-response-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const state = { messages: [], raw: [], closed: false };
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    l0CompilerFn: async () => '# Fixture identity',
    rawArchive: { append: async (_id, raw) => state.raw.push(structuredClone(raw)) },
    profile: { enabled: true, autoApprove: true, model, homeRoot: join(root, 'profile') },
  });
  try {
    for await (const message of service.invoke('fixture request', {
      invocationId: 'split-response-fixture',
      workingDirectory: workspace,
      signal,
      ...(internal ? { activeRunDispatch: { invocationId: 'split-response-fixture', register: () => () => {} } } : {}),
      spawnCliOverride: async function* (launch) {
        try {
          launch.onStdinReady?.(() => {});
          yield {
            event: 'init',
            conversation_id: session,
            init: {
              cwd: launch.cwd,
              agent: launch.args[launch.args.indexOf('--agent') + 1],
              model,
              permission_mode: 'always-proceed',
              tools: ['view_file'],
            },
          };
          for (const event of events) {
            if (event.event === 'result') beforeResult?.();
            yield event;
          }
        } finally {
          state.closed = true;
        }
      },
    }))
      state.messages.push(message);
    assert.equal(state.closed, true, 'producer must close before the service returns');
    assert.equal(state.messages.filter((m) => m.type === 'done').length, 1, 'one host terminal');
    return state;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a recovered error qualifies the entire ordered, completed split response', () => {
  const events = fixture();
  const { turn, metadata, messages } = project(events);
  assert.equal(turn.completedResponseStep, 4);
  assert.deepEqual(turn.recoveredErrorSteps, [1]);
  assert.equal(metadata.diagnostics.agyNative.upstreamStatus, 'ERROR');
  assert.equal(metadata.diagnostics.agyNative.outcome, 'ok');
  assert.equal(messages.at(-1).errorCode, undefined);
  assert.equal(messages.find((m) => m.type === 'text').content, events.at(-1).result.response);
});

for (const internal of [false, true]) {
  test(`Service delivers a recovered split response once: internal=${internal}`, async () => {
    const events = fixture();
    const { messages, raw } = await serviceRun(events, { internal });
    assert.equal(messages.filter((m) => m.type === 'error').length, 0);
    assert.equal(messages.at(-1).errorCode, undefined);
    let shown = '';
    for (const m of messages.filter((m) => m.type === 'text'))
      shown = m.textMode === 'replace' ? m.content : shown + m.content;
    assert.equal(shown, events.at(-1).result.response, 'preface and final text remain intact without duplication');
    const results = messages.filter((m) => m.type === 'tool_result');
    assert.equal(results.length, 1);
    assert.equal(results[0].toolResultStatus, 'ok');
    assert.equal(raw.at(-1).result.status, 'ERROR', 'archive preserves the actual provider envelope');
    assert.equal(raw.at(-1).result.error, events.at(-1).result.error);
    assert.equal(messages.at(-1).metadata.usage.totalTokens, 40, 'per-step usage is accounted once');
  });
}

function revisitedResponse(higherState = 'DONE') {
  const events = fixture();
  events.splice(4, 1); // Only one response identity remains, before the higher tool index.
  events[3].step_update.state = higherState;
  events.at(-1).result.response = events[2].step_update.text_delta;
  events.splice(-1, 0, extraStep(2, 'agent_response'));
  return events;
}

for (const state of ['DONE', 'ACTIVE']) {
  test(`a revisited single response cannot recover an error after a higher ${state} step`, () => {
    const { turn, messages } = project(revisitedResponse(state));
    assert.equal(turn.lastStepIndex, 2, 'retain actual observation order for diagnosis');
    assert.equal(turn.completedResponseStep, null);
    assert.deepEqual(turn.recoveredErrorSteps, []);
    assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
  });
}

for (const internal of [false, true]) {
  test(`Service preserves provider failure after a single response index rolls back: internal=${internal}`, async () => {
    const { messages, raw } = await serviceRun(revisitedResponse(), { internal });
    assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
    assert.match(messages.find((m) => m.type === 'error').error, /fixture request failed: EOF/);
    assert.equal(raw.at(-1).result.status, 'ERROR');
  });
}

test('a revisited checkpoint cannot recover an error after a higher tool index', () => {
  const events = revisitedResponse();
  events[2] = extraStep(2, 'checkpoint');
  events[4] = extraStep(2, 'checkpoint');
  events.at(-1).result.response = '';
  const turn = summarizeAgyStreamJsonTurn(events.map(JSON.stringify));
  assert.equal(turn.completedCompactionStep, null);
  assert.deepEqual(turn.recoveredErrorSteps, []);
  const messages = projectAgyNativeTurn(
    'gemini38',
    { provider: 'google', model },
    { sessionId: session, turn, transportError: null },
    false,
    undefined,
    true,
  );
  assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
});

test('an orphan marker cannot prove reply completion after the response index rolls back', () => {
  const events = revisitedResponse();
  events[1] = extraStep(1, 'unknown', { duration_seconds: 0.1 });
  Object.assign(events.at(-1).result, { status: 'SUCCESS', error: undefined });
  const { turn, metadata, messages } = project(events);
  assert.equal(turn.outcome, 'protocol_error');
  assert.equal(turn.completedResponseStep, null);
  assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
  assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
});

test('a duplicate DONE at the actual highest response index still proves recovery', () => {
  const events = fixture();
  events.splice(-1, 0, extraStep(4, 'agent_response'));
  const { turn, messages } = project(events);
  assert.equal(turn.completedResponseStep, 4);
  assert.deepEqual(turn.recoveredErrorSteps, [1]);
  assert.equal(messages.at(-1).errorCode, undefined);
});

for (const [label, mutate] of [
  [
    'unfinished final',
    (e) => {
      e[4].step_update.state = 'ACTIVE';
    },
  ],
  [
    'unfinished prefix',
    (e) => {
      e[2].step_update.state = 'ACTIVE';
    },
  ],
  [
    'response mismatch',
    (e) => {
      e.at(-1).result.response += 'unobserved';
    },
  ],
  [
    'late error',
    (e) => {
      e.splice(-1, 0, extraStep(5, 'error_message'));
    },
  ],
  [
    'failed current response',
    (e) => {
      e[4].step_update.state = 'ERROR';
    },
  ],
  [
    'unknown identity',
    (e) => {
      e[3].step_update.step_type = 'future_unknown_step';
    },
  ],
  [
    'prefix before input',
    (e) => {
      e[0].step_update.step_index = 2;
      e[2].step_update.step_index = 0;
    },
  ],
  [
    'response revisited out of order',
    (e) => {
      e.splice(-1, 0, extraStep(2, 'agent_response'));
    },
  ],
  [
    'current authentication failure',
    (e) => {
      e.splice(1, 1);
      e.at(-1).result.error = '401 UNAUTHENTICATED';
    },
  ],
]) {
  test(`split-response recovery preserves failure: ${label}`, () => {
    const events = fixture();
    mutate(events);
    const { messages } = project(events);
    assert.ok(messages.at(-1).errorCode);
    assert.equal(isConfirmedNativeAuthFailure(messages.find((m) => m.type === 'error')), false);
  });
}

for (const [label, options, expected] of [
  ['transport failed', { transportError: 'fixture CLI exited nonzero' }, 'AGY_NATIVE_FAILED'],
  ['cancelled', { cancelled: true }, 'AGY_CANCELLED'],
]) {
  test(`a complete split response cannot clear ${label}`, () => {
    assert.equal(project(fixture(), options).messages.at(-1).errorCode, expected);
  });
}

test('a denied action with no final response remains denied', () => {
  const events = fixture();
  Object.assign(events.at(-1).result, {
    status: 'SUCCESS',
    response: '',
    error: undefined,
    denied_actions: [{ action: 'run_command' }],
  });
  assert.equal(project(events).messages.at(-1).errorCode, 'AGY_PERMISSION_DENIED');
});

for (const [label, cause, pattern] of [
  ['EOF', 'fixture current request failed: EOF', /fixture current request failed: EOF/],
  ['authentication', '401 UNAUTHENTICATED', /401 UNAUTHENTICATED/],
  ['policy', policyError, /上游内容安全策略拦截了本次调用/],
]) {
  test(`internal Service preserves the current ${label} reason and stays failed`, async () => {
    const events = fixture();
    events.splice(1, 1); // No earlier error checkpoint to be superseded by the reply.
    events.at(-1).result.error = cause;
    const { messages } = await serviceRun(events, { internal: true });
    const error = messages.find((m) => m.type === 'error');
    assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
    assert.match(error.error, pattern);
    assert.equal(isConfirmedNativeAuthFailure(error), false, 'stdout alone cannot authorize 401 recovery');
    if (label === 'policy') {
      assert.equal(error.metadata.cliDiagnostics.reasonCode, 'upstream_policy_reject');
      assert.equal(error.metadata.cliDiagnostics.debugRef.invocationId, 'split-response-fixture');
    }
  });
}

test('internal cancellation retains its own reason over the provider error', async () => {
  const abort = new AbortController();
  const { messages } = await serviceRun(fixture(), {
    internal: true,
    signal: abort.signal,
    beforeResult: () => abort.abort(),
  });
  assert.equal(messages.at(-1).errorCode, 'AGY_CANCELLED');
  assert.match(messages.find((m) => m.type === 'error').error, /cancelled/);
});
