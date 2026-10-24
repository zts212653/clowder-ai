import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const { projectAgyNativeTurn, readAgyNativeTurn, observeAgyNativeTurn } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js'
);
const { summarizeAgyStreamJsonTurn } = await import(
  '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js'
);

const expected = { agentName: 'f325-agent', spawnCwd: '/tmp/f325-sandbox', model: 'gemini-3.8-flash-high' };
const init = {
  event: 'init',
  conversation_id: 'session-1',
  init: {
    agent: expected.agentName,
    cwd: expected.spawnCwd,
    model: expected.model,
    permission_mode: 'request-review',
  },
};

test('recorded official CLI followups retain separate turns and non-cumulative usage', async () => {
  for (const name of ['default', 'immediate']) {
    const events = readFileSync(new URL(`./fixtures/agy-stream-json/followup-${name}.ndjson`, import.meta.url), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.event);
    // The spike used the default upstream agent; adapt only its init to the host-owned fixture agent.
    events[0] = { ...events[0], init: { ...events[0].init, agent: 'recorded-fixture' } };
    const expected = {
      agentName: 'recorded-fixture',
      spawnCwd: events[0].init.cwd,
      model: events[0].init.model,
      permissionMode: 'always-proceed',
    };
    const turns = [];
    for await (const observed of observeAgyNativeTurn(
      (async function* () {
        yield* events;
      })(),
      expected,
      undefined,
      true,
    ))
      if (observed.kind === 'result') turns.push(observed.observed.turn);
    assert.equal(turns.length, 2);
    assert.deepEqual(
      turns.map((turn) => turn.outcome),
      ['ok', 'ok'],
    );
    assert.equal(turns[0].turnUsage.inputTokens, turns[0].usage.inputTokens);
    assert.equal(turns[1].turnUsage.inputTokens, turns[1].usage.inputTokens - turns[0].usage.inputTokens);
    assert.notEqual(turns[1].turnUsage.inputTokens, turns[1].usage.inputTokens);
    assert.match(turns[0].finalText, /A_DONE NONE/);
    assert.match(turns[1].finalText, /A_DONE PAPAYA/);
    assert.equal(turns[0].toolCalls.length, name === 'default' ? 1 : 2, 'A contains the recorded tools');
    assert.equal(turns[1].toolCalls.length, 0, 'A tool observations do not bleed into B');
  }
});

describe('F325 native stream boundary', () => {
  test('bounds accumulated upstream output before a tool can exhaust the API process', async () => {
    async function* oversized() {
      yield init;
      yield {
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'view_file',
          tool_info: { output: 'x'.repeat(9 * 1024 * 1024) },
        },
      };
      yield { event: 'result', result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'done' } };
    }
    await assert.rejects(() => readAgyNativeTurn(oversized(), expected), /stream.*limit|bounded.*output/i);
  });

  test('rejects a second terminal result in a one-turn process', async () => {
    async function* duplicate() {
      yield init;
      yield { event: 'result', result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'one' } };
      yield { event: 'result', result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'two' } };
    }
    await assert.rejects(() => readAgyNativeTurn(duplicate(), expected), /multiple terminal/i);
  });

  test('does not report success if an unrecognized native tool appears in the tool steps', () => {
    const lines = [
      JSON.stringify(init),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'future_unknown_native_tool',
          tool_info: { parameters: { CommandLine: 'echo unsafe' }, output: 'unsafe' },
        },
      }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'done' },
      }),
    ];
    const turn = summarizeAgyStreamJsonTurn(lines);
    const messages = projectAgyNativeTurn(
      'gemini38',
      { provider: 'google', model: expected.model },
      { sessionId: 'session-1', turn, transportError: null },
      false,
    );
    assert.equal(messages.at(-1).errorCode, 'AGY_UNEXPECTED_TOOL');
    assert.ok(messages.some((message) => message.type === 'text'));
  });

  test('retains failed MCP results while delivering the provider response', () => {
    for (const state of ['ERROR', 'DONE']) {
      const lines = [
        JSON.stringify(init),
        JSON.stringify({
          event: 'step_update',
          step_update: {
            conversation_id: 'session-1',
            step_index: 1,
            state,
            step_type: 'tool',
            tool_name: 'call_mcp_tool',
            tool_info: {
              parameters: {
                ServerName: 'cat-cafe-collab',
                ToolName: 'cat_cafe_get_thread_context',
                Arguments: { responseMode: 'full' },
              },
              error: { type: 'TOOL_ERROR', message: 'fixture transport failed' },
            },
          },
        }),
        JSON.stringify({
          event: 'result',
          result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'All done.' },
        }),
      ];
      const turn = summarizeAgyStreamJsonTurn(lines);
      const messages = projectAgyNativeTurn(
        'gemini38',
        { provider: 'google', model: expected.model },
        { sessionId: 'session-1', turn, transportError: null },
        false,
      );
      assert.equal(messages.at(-1).errorCode, undefined);
      assert.equal(messages.find((message) => message.type === 'tool_result').toolResultStatus, 'error');
      assert.equal(messages.find((message) => message.type === 'text')?.content, 'All done.');
    }
  });

  test('keeps the final and failed result when a missing-file observation precedes a successful read', () => {
    const lines = [
      JSON.stringify(init),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: 1,
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'view_file',
          tool_info: { parameters: { TargetFile: 'missing.ts' }, error: { message: 'File not found' } },
        },
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: 2,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'view_file',
          tool_info: { parameters: { TargetFile: 'correct.ts' }, output: 'correct source' },
        },
      }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'Found the source.' },
      }),
    ];
    const turn = summarizeAgyStreamJsonTurn(lines);
    const messages = projectAgyNativeTurn(
      'gemini38',
      { provider: 'google', model: expected.model },
      { sessionId: 'session-1', turn, transportError: null },
      false,
    );
    assert.equal(messages.at(-1).errorCode, undefined);
    assert.equal(messages.find((message) => message.type === 'text').content, 'Found the source.');
    assert.equal(messages.find((message) => message.type === 'tool_result').toolResultStatus, 'error');
  });
});

function projectReadSteps(calls, overrides = {}) {
  const turn = summarizeAgyStreamJsonTurn([
    JSON.stringify(init),
    ...calls.map((call, index) =>
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: index + 1,
          step_type: 'tool',
          ...call,
        },
      }),
    ),
    JSON.stringify({
      event: 'result',
      result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'Read observations.', ...overrides.result },
    }),
  ]);
  return projectAgyNativeTurn(
    'gemini38',
    { provider: 'google', model: expected.model },
    { sessionId: 'session-1', turn, transportError: overrides.transportError ?? null },
    overrides.cancelled ?? false,
  );
}

const readSuccess = { state: 'DONE', tool_name: 'view_file', tool_info: { output: '4 lines, 153 bytes' } };
const mcpParameters = { ServerName: 'cat-cafe-collab', ToolName: 'cat_cafe_get_thread_context' };
const alphaMissingRead = {
  state: 'ERROR',
  tool_name: 'view_file',
  tool_info: {
    parameters: { AbsolutePath: '/tmp/f325-profile/cwd/hash/README.md' },
    error: {
      message:
        'declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: ' +
        'invalid tool call error (invalid_args) failed to read file: stat /tmp/f325-profile/cwd/hash/README.md: no such file or directory',
    },
  },
};

describe('F325 native missing-file observations', () => {
  test('delivers the final answer with an honest missing-file result regardless of read order', () => {
    for (const calls of [[readSuccess, alphaMissingRead], [alphaMissingRead], [alphaMissingRead, readSuccess]]) {
      const messages = projectReadSteps(calls);
      assert.equal(messages.at(-1).errorCode, undefined);
      assert.equal(messages.find((message) => message.type === 'text')?.content, 'Read observations.');
      const missing = messages.find(
        (message) => message.type === 'tool_result' && message.toolResultStatus === 'error',
      );
      assert.equal(missing.content, alphaMissingRead.tool_info.error.message);
      assert.deepEqual(messages.at(-1).metadata.diagnostics.agyNative.readObservations, [
        { stepIndex: calls.indexOf(alphaMissingRead) + 1, toolName: 'view_file', outcome: 'not_found' },
      ]);
    }
  });

  test('does not infer carrier permission denial from unstructured tool error wording', () => {
    for (const message of [
      'permission denied',
      'EACCES: failed to read file',
      'invalid_args: unsafe path',
      alphaMissingRead.tool_info.error.message.replace('/tmp/f325-profile/cwd/hash/README.md', '/tmp/other-file'),
      `${alphaMissingRead.tool_info.error.message}; permission denied`,
    ]) {
      const error = { ...alphaMissingRead, tool_info: { ...alphaMissingRead.tool_info, error: { message } } };
      const messages = projectReadSteps([error, readSuccess]);
      assert.equal(messages.at(-1).errorCode, undefined, message);
      assert.equal(messages.find((entry) => entry.type === 'tool_result').toolResultStatus, 'error');
      assert.equal(messages.find((entry) => entry.type === 'text')?.content, 'Read observations.');
    }
  });

  test('missing-file wording does not hide an error result when metadata is sparse', () => {
    for (const tool_info of [
      { ...alphaMissingRead.tool_info, parameters: {} },
      { ...alphaMissingRead.tool_info, output: 'unexpected file content' },
      { parameters: {}, error: { message: 'File not found' } },
      { parameters: { AbsolutePath: '' }, error: { message: 'File not found' } },
      { parameters: { AbsolutePath: '  ' }, error: { message: 'File not found' } },
    ]) {
      const messages = projectReadSteps([{ ...alphaMissingRead, tool_info }, readSuccess]);
      assert.equal(messages.at(-1).errorCode, undefined);
      assert.equal(messages.find((entry) => entry.type === 'text')?.content, 'Read observations.');
    }
  });

  test('all declared tools preserve error results independently of the carrier outcome', () => {
    for (const tool_name of [
      'write_to_file',
      'replace_file_content',
      'call_mcp_tool',
      'list_dir',
      'find_by_name',
      'grep_search',
    ]) {
      for (const message of ['File not found', alphaMissingRead.tool_info.error.message]) {
        const messages = projectReadSteps([
          {
            ...alphaMissingRead,
            tool_name,
            tool_info: {
              parameters: {
                AbsolutePath: alphaMissingRead.tool_info.parameters.AbsolutePath,
                TargetFile: alphaMissingRead.tool_info.parameters.AbsolutePath,
                ...mcpParameters,
              },
              error: { message },
            },
          },
          { ...readSuccess, tool_name, tool_info: { ...readSuccess.tool_info, parameters: mcpParameters } },
        ]);
        assert.equal(messages.at(-1).errorCode, undefined, `${tool_name}: ${message}`);
        assert.equal(messages.find((entry) => entry.type === 'tool_result').toolResultStatus, 'error');
        assert.equal(messages.find((entry) => entry.type === 'text')?.content, 'Read observations.');
      }
    }
  });

  test('an ERROR tool state without an error message stays an error result', () => {
    for (const tool_name of ['view_file', 'list_dir', 'write_to_file']) {
      const messages = projectReadSteps([{ state: 'ERROR', tool_name, tool_info: {} }, readSuccess]);
      assert.equal(messages.at(-1).errorCode, undefined);
      assert.equal(messages.find((entry) => entry.type === 'text')?.content, 'Read observations.');
    }
  });

  test('missing-file observations never override denial, cancellation, transport or protocol failure', () => {
    for (const [overrides, code] of [
      [
        { result: { response: '', denied_actions: [{ action: 'view_file', display_name: 'view_file' }] } },
        'AGY_PERMISSION_DENIED',
      ],
      [{ cancelled: true }, 'AGY_CANCELLED'],
      [{ transportError: 'fixture transport failure' }, 'AGY_NATIVE_FAILED'],
      [{ result: { status: 'ERROR', error: 'fixture provider failure' } }, 'AGY_NATIVE_FAILED'],
    ]) {
      const messages = projectReadSteps([alphaMissingRead], overrides);
      assert.equal(messages.at(-1).errorCode, code);
      if (!overrides.result?.denied_actions) assert.ok(messages.some((entry) => entry.type === 'text'));
    }
  });
});
