import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { projectAgyNativeTurn, readAgyNativeTurn } = await import(
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

  test('does not report success if an undeclared native command appears in the tool steps', () => {
    const lines = [
      JSON.stringify(init),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'run_command',
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
    assert.ok(!messages.some((message) => message.type === 'text'));
  });

  test('only the exact task-scoped MCP pair may appear in a successful turn', () => {
    const lines = [
      JSON.stringify(init),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'call_mcp_tool',
          tool_info: {
            parameters: {
              ServerName: 'cat-cafe-collab',
              ToolName: 'cat_cafe_get_thread_context',
              Arguments: '{"responseMode":"full"}',
            },
            output: 'thread context',
          },
        },
      }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'done' },
      }),
    ];
    const turn = summarizeAgyStreamJsonTurn(lines);
    const observed = { sessionId: 'session-1', turn, transportError: null };
    const metadata = { provider: 'google', model: expected.model };
    const allowed = projectAgyNativeTurn('gemini38', { ...metadata }, observed, false, [
      'cat-cafe-collab/cat_cafe_get_thread_context',
    ]);
    assert.equal(allowed.at(-1).errorCode, undefined);
    for (const grants of [[], ['cat-cafe-collab/cat_cafe_post_message']]) {
      const denied = projectAgyNativeTurn('gemini38', { ...metadata }, observed, false, grants);
      assert.equal(denied.at(-1).errorCode, 'AGY_UNEXPECTED_TOOL');
    }
  });

  test('does not turn a failed MCP step into success when upstream result says SUCCESS', () => {
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
        ['cat-cafe-collab/cat_cafe_get_thread_context'],
      );
      assert.equal(messages.at(-1).errorCode, 'AGY_TOOL_FAILED');
      assert.equal(messages.find((message) => message.type === 'tool_result').toolResultStatus, 'error');
      assert.ok(!messages.some((message) => message.type === 'text' && message.content === 'All done.'));
    }
  });

  test('keeps a final answer after a failed read is recovered by a later successful read', () => {
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
