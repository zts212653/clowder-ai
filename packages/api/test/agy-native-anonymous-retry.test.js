import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isConfirmedNativeAuthFailure } from '../dist/domains/cats/services/agents/invocation/native-auth-continuation.js';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { projectAgyNativeTurn } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js';
import { summarizeAgyStreamJsonTurn } from '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js';

const session = 'anonymous-retry-session';
const model = 'gemini-3.8-flash-high';
const eof = 'API error (attempt 1): fixture request failed: EOF';
const policy =
  'Your previous response was blocked by content safety filters\nOutput retries exhausted after 4 attempts';
const step = (index, type, fields = {}) => ({
  event: 'step_update',
  step_update: { conversation_id: session, step_index: index, step_type: type, state: 'DONE', ...fields },
});
// Natural source197's shape only; no private text, tool arguments or transcript dependency.
function fixture() {
  return [
    step(0, 'user_input'),
    step(1, 'agent_response', { text_delta: 'Checking. ' }),
    step(44, 'tool', { tool_name: 'view_file', tool_info: { output: 'fixture output' } }),
    step(45, 'error_message'),
    step(46, 'agent_response'),
    step(47, 'unknown', { duration_seconds: 0.210942 }),
    step(48, 'system_message'),
    step(49, 'agent_response', { text_delta: 'Complete reply.' }),
    {
      event: 'result',
      result: {
        conversation_id: session,
        status: 'ERROR',
        error: eof,
        num_turns: 1,
        response: 'Checking. Complete reply.',
      },
    },
  ];
}
function project(events, { transportError = null, cancelled = false } = {}) {
  const turn = summarizeAgyStreamJsonTurn(events.map(JSON.stringify));
  const metadata = { provider: 'google', model };
  const messages = projectAgyNativeTurn('gemini38', metadata, { turn, sessionId: session, transportError }, cancelled);
  return { turn, metadata, messages };
}
function assertUnconfirmed({ turn, metadata, messages }) {
  assert.equal(messages.at(-1).errorCode, undefined);
  assert.equal(metadata.diagnostics.agyNative.outcome, 'unconfirmed');
  assert.equal(metadata.diagnostics.agyNative.upstreamStatus, 'ERROR');
  assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
  assert.equal(metadata.diagnostics.agyNative.retainedUnconfirmedError, eof);
  assert.equal(turn.completedResponseStep, null, 'unknown operation cannot become confirmed recovery evidence');
  assert.equal(turn.stepsComplete, false);
  assert.deepEqual(turn.unconfirmedStepIndices, [47]);
  assert.equal(
    turn.toolCalls.some((call) => call.stepIndex === 47),
    false,
    'never invent a wait identity',
  );
  assert.equal(
    messages.some((m) => m.semanticEvent?.kind === 'warning' && /身份未确认/.test(m.semanticEvent.message)),
    true,
  );
  assert.equal(
    messages.some((m) => m.type === 'tool_result' && m.toolUseId === `${session}:47`),
    false,
  );
  assert.equal(messages.find((m) => m.type === 'text').content, 'Checking. Complete reply.');
  assert.equal(isConfirmedNativeAuthFailure(messages.at(-1)), false);
}

test('a recovered attempt and anonymous completion deliver the complete reply as unconfirmed', () => {
  assertUnconfirmed(project(fixture()));
});

test('unconfirmed reply delivery keeps an earlier named tool failure visible', () => {
  const events = fixture();
  events.splice(
    2,
    0,
    step(12, 'tool', {
      tool_name: 'run_command',
      state: 'ERROR',
      tool_info: { error: { message: 'fixture tool failed' } },
    }),
  );
  const result = project(events);
  assertUnconfirmed(result);
  const failed = result.messages.find((m) => m.type === 'tool_result' && m.toolUseId === `${session}:12`);
  assert.equal(failed.toolResultStatus, 'error');
  assert.match(failed.content, /fixture tool failed/);
});

async function runService(events, internal) {
  const root = mkdtempSync(join(tmpdir(), 'agy-anonymous-retry-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const messages = [],
    raw = [];
  let closed = false;
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    l0CompilerFn: async () => '# Fixture identity',
    rawArchive: { append: async (_id, event) => raw.push(structuredClone(event)) },
    profile: { enabled: true, autoApprove: true, model, homeRoot: join(root, 'profile') },
  });
  try {
    for await (const message of service.invoke('fixture request', {
      invocationId: 'anonymous-retry-fixture',
      workingDirectory: workspace,
      ...(internal ? { activeRunDispatch: { invocationId: 'anonymous-retry-fixture', register: () => () => {} } } : {}),
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
          yield* events;
        } finally {
          closed = true;
        }
      },
    }))
      messages.push(message);
    assert.equal(closed, true);
    assert.equal(messages.filter((m) => m.type === 'done').length, 1);
    return { messages, raw };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const internal of [false, true]) {
  test(`Service delivers once and preserves sanitized retry cause and raw ERROR: internal=${internal}`, async () => {
    const privatePath = join(homedir(), 'fixture-private', 'retry.log');
    const privateCause = `API error (attempt 1): fixture request failed at ${privatePath}: EOF`;
    const events = fixture();
    events.at(-1).result.error = privateCause;
    const { messages, raw } = await runService(events, internal);
    assert.equal(messages.filter((m) => m.type === 'error').length, 0);
    assert.equal(messages.at(-1).errorCode, undefined);
    const terminal = messages.at(-1).metadata.diagnostics.agyNative;
    assert.equal(terminal.outcome, 'unconfirmed');
    assert.equal(terminal.upstreamStatus, 'ERROR');
    assert.equal(terminal.toolResultsConfirmed, false);
    assert.equal(
      terminal.retainedUnconfirmedError,
      `API error (attempt 1): fixture request failed at ${join('~', 'fixture-private', 'retry.log')}: EOF`,
    );
    assert.equal(terminal.retainedUnconfirmedError.includes(privatePath), false);
    assert.equal(
      messages.some((m) => m.type === 'tool_result' && m.toolUseId === `${session}:47`),
      false,
    );
    assert.equal(
      messages.some((m) => /身份未确认/.test(m.semanticEvent?.message ?? '')),
      true,
    );
    let text = '';
    for (const m of messages.filter((m) => m.type === 'text'))
      text = m.textMode === 'replace' ? m.content : text + m.content;
    assert.equal(text, 'Checking. Complete reply.');
    assert.equal(raw.at(-1).result.status, 'ERROR');
    assert.equal(raw.at(-1).result.error, privateCause);
  });
}

for (const [label, change] of [
  ['current EOF without a recovered error step', (e) => e.splice(3, 1)],
  [
    'current 401',
    (e) => {
      e.at(-1).result.error = '401 UNAUTHENTICATED';
    },
  ],
  [
    'non-attempt EOF',
    (e) => {
      e.at(-1).result.error = 'fixture current request failed: EOF';
    },
  ],
  [
    'authentication failure wrapped as an attempt EOF',
    (e) => {
      e.at(-1).result.error = 'API error (attempt 1): 401 UNAUTHENTICATED: EOF';
    },
  ],
  [
    'policy failure wrapped as an attempt EOF',
    (e) => {
      e.at(-1).result.error = `API error (attempt 1): ${policy.split('\n')[0]}: EOF`;
    },
  ],
  [
    'current policy rejection',
    (e) => {
      e.at(-1).result.error = policy;
    },
  ],
  [
    'denied operation',
    (e) => {
      e.at(-1).result.denied_actions = [{ action: 'run_command' }];
    },
  ],
  [
    'unfinished final reply',
    (e) => {
      e[7].step_update.state = 'ACTIVE';
    },
  ],
  [
    'unfinished prefix',
    (e) => {
      e[1].step_update.state = 'ACTIVE';
    },
  ],
  [
    'unfinished tool',
    (e) => {
      e[2].step_update.state = 'ACTIVE';
    },
  ],
  [
    'mismatched result response',
    (e) => {
      e.at(-1).result.response += '\nextra';
    },
  ],
  ['new error after final reply', (e) => e.splice(-1, 0, step(50, 'error_message'))],
  ['response index rollback', (e) => e.splice(-1, 0, step(46, 'agent_response'))],
  [
    'extra marker fields',
    (e) => {
      e[5].step_update.tool_name = 'wait';
    },
  ],
  [
    'marker before input',
    (e) => {
      e[0].step_update.step_index = 48;
    },
  ],
]) {
  test(`anonymous retry evidence does not clear ${label}`, () => {
    const events = fixture();
    change(events);
    const { messages, metadata } = project(events);
    assert.ok(messages.at(-1).errorCode);
    if (['unfinished final reply', 'unfinished tool', 'mismatched result response'].includes(label)) {
      assert.match(messages.find((m) => m.type === 'error').error, /fixture request failed: EOF/);
    }
    assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
    assert.equal(isConfirmedNativeAuthFailure(messages.find((m) => m.type === 'error')), false);
  });
}

for (const cause of ['401 UNAUTHENTICATED', policy]) {
  test(`internal Service preserves current rejection: ${cause.split('\n')[0]}`, async () => {
    const events = fixture();
    events.at(-1).result.error = cause;
    const { messages } = await runService(events, true);
    assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
    assert.equal(isConfirmedNativeAuthFailure(messages.find((m) => m.type === 'error')), false);
  });
}

for (const [label, options, errorCode] of [
  ['transport failure', { transportError: 'fixture transport lost' }, 'AGY_NATIVE_FAILED'],
  ['cancellation', { cancelled: true }, 'AGY_CANCELLED'],
])
  test(`anonymous completed reply retains ${label}`, () => {
    assert.equal(project(fixture(), options).messages.at(-1).errorCode, errorCode);
  });
