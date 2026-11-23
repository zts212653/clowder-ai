import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AgyNativeProgress } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-progress.js';
import { projectAgyNativeTurn } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js';
import {
  parseAgyStreamJsonLine,
  summarizeAgyStreamJsonTurn,
} from '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js';
import { toStoredToolEvent } from '../dist/domains/cats/services/agents/routing/route-helpers.js';

const sessionId = 'subagent-fixture-session';
const recorded = () =>
  readFileSync(new URL('./fixtures/agy-stream-json/subagent-invocations.ndjson', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
const parentReply = 'The parent has received the launch receipts.';
const turnEvents = (events) => [
  {
    event: 'step_update',
    step_update: { conversation_id: sessionId, step_index: 235, step_type: 'user_input', state: 'DONE' },
  },
  ...events,
  {
    event: 'step_update',
    step_update: {
      conversation_id: sessionId,
      step_index: 240,
      step_type: 'agent_response',
      state: 'DONE',
      text_delta: parentReply,
    },
  },
  { event: 'result', result: { conversation_id: sessionId, status: 'SUCCESS', response: parentReply, num_turns: 1 } },
];
const summarize = (events) => summarizeAgyStreamJsonTurn(turnEvents(events).map(JSON.stringify));
const metadata = () => ({ provider: 'google', model: 'fixture', sessionId });

test('recorded AGY 1.5.12 subagent launches retain tool identities and child launch receipts', () => {
  const turn = summarize(recorded());
  assert.equal(turn.outcome, 'ok', turn.diagnosis);
  assert.equal(turn.stepsComplete, true);
  assert.equal(turn.completedResponseStep, 240);
  assert.equal(turn.toolCalls.length, 4);
  for (const call of turn.toolCalls) {
    assert.equal(call.toolName, 'invoke_subagent');
    assert.equal(call.state, 'DONE');
    assert.equal(call.parameters.subagents[0].initial_prompt, 'Return a short fixture result.');
    assert.equal(JSON.parse(call.output).subagents[0].conversation_id, `subagent-fixture-child-${call.stepIndex}`);
  }
  const progress = new AgyNativeProgress('fixture-cat', metadata());
  const live = recorded().flatMap((raw) => progress.step(parseAgyStreamJsonLine(JSON.stringify(raw))));
  assert.equal(live.filter((m) => m.type === 'tool_use').length, 4);
  assert.equal(live.filter((m) => m.type === 'tool_result' && m.toolResultStatus === 'ok').length, 4);
  assert.equal(live.filter((m) => m.type === 'text').length, 0, 'child prompts are not parent response deltas');
});

test('a started subagent without DONE is retained as an unfinished operation', () => {
  const turn = summarize(recorded().filter((e) => e.step_update.state === 'ACTIVE'));
  assert.equal(turn.outcome, 'ok', 'the parent may deliver a useful response');
  assert.equal(turn.stepsComplete, false);
  assert.ok(turn.toolCalls.every((call) => call.state === 'ACTIVE'));
  const meta = metadata();
  projectAgyNativeTurn('fixture-cat', meta, { sessionId, turn, transportError: null }, false);
  assert.equal(meta.diagnostics.agyNative.toolResultsConfirmed, false);
});

test('a failed subagent launch preserves error evidence in batch and live consumers', () => {
  const events = recorded().slice(0, 2);
  const done = events[1].step_update;
  done.state = 'ERROR';
  done.tool_info = { error: { message: 'Subagent launch failed' } };
  const turn = summarize(events);
  assert.equal(turn.toolCalls[0].state, 'ERROR');
  assert.match(turn.toolCalls[0].errorMessage, /launch failed/);
  const progress = new AgyNativeProgress('fixture-cat', metadata());
  const live = events.flatMap((raw) => progress.step(parseAgyStreamJsonLine(JSON.stringify(raw))));
  assert.equal(live.find((m) => m.type === 'tool_result').toolResultStatus, 'error');
});

test('subagent text is not rendered as the parent reply and conventional errors remain visible', () => {
  const events = recorded().slice(0, 2);
  events[0].step_update.text_delta = 'Child-side text is not the parent reply.';
  events[1].step_update.tool_info = { error: { message: 'Launch receipt contains a failure' } };
  const progress = new AgyNativeProgress('fixture-cat', metadata());
  const live = events.flatMap((raw) => progress.step(parseAgyStreamJsonLine(JSON.stringify(raw))));
  assert.equal(live.filter((m) => m.type === 'text').length, 0);
  assert.equal(live.find((m) => m.type === 'tool_result').toolResultStatus, 'error');
  assert.match(summarize(events).toolCalls[0].errorMessage, /contains a failure/);
});

test('a later valid receipt cannot erase earlier malformed launch evidence', () => {
  const events = recorded().slice(0, 2);
  events[0].step_update.subagent_info = [];
  const turn = summarize(events);
  assert.equal(turn.outcome, 'protocol_error');
  const progress = new AgyNativeProgress('fixture-cat', metadata());
  const live = events.flatMap((raw) => progress.step(parseAgyStreamJsonLine(JSON.stringify(raw))));
  assert.equal(live.find((m) => m.type === 'tool_result').toolResultStatus, 'error');
});

test('malformed or unrecognized subagent evidence is never promoted to confirmed success', () => {
  const mutations = [
    [
      'explicit null info',
      (s) => {
        s.subagent_info = null;
      },
    ],
    [
      'unreadable info',
      (s) => {
        s.subagent_info = 'unreadable';
      },
    ],
    [
      'unreadable children',
      (s) => {
        s.subagent_info.subagents = {};
      },
    ],
    [
      'empty children',
      (s) => {
        s.subagent_info.subagents = [];
      },
    ],
    [
      'unreadable child',
      (s) => {
        s.subagent_info.subagents = [null];
      },
    ],
    [
      'unreadable task identity',
      (s) => {
        s.subagent_info.subagents[0].type_name = 7;
      },
    ],
    [
      'unreadable role',
      (s) => {
        s.subagent_info.subagents[0].role = null;
      },
    ],
    [
      'unreadable prompt',
      (s) => {
        s.subagent_info.subagents[0].initial_prompt = {};
      },
    ],
    [
      'unreadable launch receipt',
      (s) => {
        s.subagent_info.subagents[0].conversation_id = '';
      },
    ],
    [
      'unreadable workspace list',
      (s) => {
        s.subagent_info.subagents[0].workspace_uris = [7];
      },
    ],
    [
      'unreadable log URI',
      (s) => {
        s.subagent_info.subagents[0].log_uri = {};
      },
    ],
    [
      'unrecognized operation',
      (s) => {
        s.tool_name = 'future_subagent_operation';
      },
    ],
    [
      'unknown lifecycle state',
      (s) => {
        s.state = 'CANCELLED';
      },
    ],
    [
      'changed owner',
      (s) => {
        s.conversation_id = 'different-parent';
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    const events = recorded().slice(0, 2);
    mutate(events[1].step_update);
    const turn = summarize(events);
    assert.equal(turn.outcome, 'protocol_error', label);
    assert.equal(turn.stepsComplete, false, label);
    const progress = new AgyNativeProgress('fixture-cat', metadata());
    const live = events.flatMap((raw) => progress.step(parseAgyStreamJsonLine(JSON.stringify(raw))));
    assert.ok(!live.some((m) => m.type === 'tool_result' && m.toolResultStatus === 'ok'), label);
  }
});

const guardRefusal = 'tool call denied by pre-tool hook: Clowder AI native guard: tool is not declared';
const project = (events, tools) => {
  const meta = metadata();
  return projectAgyNativeTurn(
    'fixture-cat',
    meta,
    { sessionId, turn: summarize(events), transportError: null },
    false,
    tools,
  );
};
const liveMessages = (events) => {
  const progress = new AgyNativeProgress('fixture-cat', metadata());
  return events.flatMap((raw) => progress.step(parseAgyStreamJsonLine(JSON.stringify(raw))));
};

for (const state of ['DONE', 'ERROR']) {
  for (const receipt of [false, true]) {
    test(`sparse subagent ${state} with ${receipt ? 'references only' : 'no repeated info'} preserves the request`, () => {
      const events = recorded().slice(0, 2);
      const terminal = events[1].step_update;
      terminal.state = state;
      if (receipt) {
        terminal.subagent_info = { subagents: [{ conversation_id: 'sparse-child-reference' }] };
      } else {
        delete terminal.subagent_info;
      }
      if (state === 'ERROR') terminal.tool_info = { error: { message: guardRefusal } };
      const turn = summarize(events);
      assert.equal(turn.outcome, 'ok', turn.diagnosis);
      assert.equal(turn.toolCalls[0].parameters.subagents[0].initial_prompt, 'Return a short fixture result.');
      assert.equal(turn.toolCalls[0].output.includes('sparse-child-reference'), receipt);
      if (!receipt) assert.equal(turn.toolCalls[0].output, '', 'missing info must not invent a launch receipt');
      for (const messages of [liveMessages(events), project(events)]) {
        const result = messages.find((m) => m.type === 'tool_result');
        assert.equal(result.toolResultStatus, state === 'DONE' ? 'ok' : 'error');
        assert.equal(result.content.includes('sparse-child-reference'), receipt);
        if (state === 'ERROR') assert.ok(result.content.includes(guardRefusal));
      }
    });
  }
}

for (const output of [undefined, '', 'Additional native diagnostic']) {
  test(`partial launch ERROR keeps references with generic output ${JSON.stringify(output)}`, () => {
    const events = recorded().slice(0, 2);
    events[1].step_update.state = 'ERROR';
    events[1].step_update.tool_info = { error: { message: guardRefusal }, ...(output === undefined ? {} : { output }) };
    const turn = summarize(events);
    assert.equal(turn.outcome, 'ok', turn.diagnosis);
    assert.ok(turn.toolCalls[0].output.includes('subagent-fixture-child-236'));
    for (const messages of [liveMessages(events), project(events, ['read_file'])]) {
      const result = messages.find((m) => m.type === 'tool_result');
      assert.equal(result.toolResultStatus, 'error');
      assert.ok(result.content.includes('subagent-fixture-child-236'));
      assert.ok(result.content.includes('file:///fixture/subagent-236/log.json'));
      assert.ok(result.content.includes('file:///fixture/workspace-0'));
      assert.ok(result.content.includes(guardRefusal));
      if (output) assert.ok(result.content.includes(output));
    }
    assert.ok(project(events, ['read_file']).some((m) => m.errorCode === 'AGY_UNEXPECTED_TOOL'));
  });
}

test('request-only hook refusal remains an attributable non-execution under read-only tools', () => {
  const events = recorded().slice(0, 2);
  events[1].step_update.state = 'ERROR';
  events[1].step_update.subagent_info = structuredClone(events[0].step_update.subagent_info);
  events[1].step_update.tool_info = { error: { message: guardRefusal } };
  const turn = summarize(events);
  assert.equal(turn.outcome, 'ok', turn.diagnosis);
  assert.equal(turn.toolCalls[0].output, '');
  assert.ok(!project(events, ['read_file']).some((m) => m.errorCode === 'AGY_UNEXPECTED_TOOL'));
});

test('DONE with empty generic output retains the actual launch receipt', () => {
  const events = recorded().slice(0, 2);
  events[1].step_update.tool_info = { output: '' };
  assert.ok(summarize(events).toolCalls[0].output.includes('subagent-fixture-child-236'));
  for (const messages of [liveMessages(events), project(events)]) {
    const result = messages.find((m) => m.type === 'tool_result');
    assert.equal(result.toolResultStatus, 'ok');
    assert.ok(result.content.includes('subagent-fixture-child-236'));
  }
});

test('generic output and invalid evidence cannot hide or certify a launch receipt', () => {
  const events = recorded().slice(0, 2);
  events[1].step_update.tool_info = { output: 'A separate native diagnostic' };
  const call = summarize(events).toolCalls[0];
  assert.ok(call.output.includes('subagent-fixture-child-236'));
  assert.ok(call.output.includes('A separate native diagnostic'));
  events[1].step_update.tool_info.output = { unreadable: true };
  assert.equal(summarize(events).outcome, 'protocol_error');
  assert.equal(liveMessages(events).find((m) => m.type === 'tool_result').toolResultStatus, 'error');
});

for (const output of [undefined, '', 'Diagnostic after the launch']) {
  test(`a receipt before sparse ERROR survives later generic output ${JSON.stringify(output)}`, () => {
    const events = recorded().slice(0, 2);
    events[0].step_update.subagent_info = structuredClone(events[1].step_update.subagent_info);
    events[1].step_update.state = 'ERROR';
    delete events[1].step_update.subagent_info;
    events[1].step_update.tool_info = { error: { message: guardRefusal }, ...(output === undefined ? {} : { output }) };
    assert.ok(summarize(events).toolCalls[0].output.includes('subagent-fixture-child-236'));
    for (const messages of [liveMessages(events), project(events, ['read_file'])]) {
      assert.ok(messages.find((m) => m.type === 'tool_result').content.includes('subagent-fixture-child-236'));
    }
    assert.ok(project(events, ['read_file']).some((m) => m.errorCode === 'AGY_UNEXPECTED_TOOL'));
  });
}

test('long requests stay in input while stored live and terminal results retain child references', () => {
  const events = recorded().slice(0, 2);
  const prompt = 'P'.repeat(2025);
  for (const event of events) event.step_update.subagent_info.subagents[0].initial_prompt = prompt;
  for (const messages of [liveMessages(events), project(events)]) {
    assert.equal(messages.find((m) => m.type === 'tool_use').toolInput.subagents[0].initial_prompt, prompt);
    const result = messages.find((m) => m.type === 'tool_result');
    const stored = toStoredToolEvent(result);
    assert.ok(stored.detail.includes('subagent-fixture-child-236'));
    assert.ok(stored.detail.includes('file:///fixture/subagent-236/log.json'));
    assert.ok(!result.content.includes(prompt), 'a launch receipt must not repeat the request payload');
  }
});

test('a terminal-only snapshot keeps its complete request in tool input', () => {
  const events = recorded().slice(1, 2);
  const prompt = 'T'.repeat(2025);
  events[0].step_update.subagent_info.subagents[0].initial_prompt = prompt;
  assert.equal(summarize(events).toolCalls[0].parameters.subagents?.[0]?.initial_prompt, prompt);
  for (const messages of [liveMessages(events), project(events)]) {
    assert.equal(messages.find((m) => m.type === 'tool_use').toolInput.subagents[0].initial_prompt, prompt);
    assert.ok(
      toStoredToolEvent(messages.find((m) => m.type === 'tool_result')).detail.includes('subagent-fixture-child-236'),
    );
  }
});
