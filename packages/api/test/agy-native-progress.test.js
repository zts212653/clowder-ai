import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { AgyNativeProgress } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-progress.js'
);
const { projectAgyNativeTurn } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js'
);
const { summarizeAgyStreamJsonTurn } = await import(
  '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js'
);

function makeStepEvent(overrides = {}) {
  return {
    kind: 'step',
    conversationId: 'session-f325',
    stepIndex: 0,
    state: 'ACTIVE',
    rawState: 'ACTIVE',
    stepType: 'tool',
    textDelta: null,
    toolName: 'run_command',
    toolParameters: null,
    toolOutput: null,
    toolErrorMessage: null,
    durationSeconds: null,
    usage: null,
    ...overrides,
  };
}

describe('F325 agy-native-progress', () => {
  const catId = 'gemini38';
  const metadata = { sessionId: 'session-f325', threadId: 'thread-test' };

  describe('tool ACTIVE -> DONE parameter and result tracking', () => {
    test('captures tool parameters on ACTIVE step and emits tool_use message', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      const messages = progress.step(
        makeStepEvent({
          stepIndex: 1,
          state: 'ACTIVE',
          stepType: 'tool',
          toolName: 'run_command',
          toolParameters: { CommandLine: 'pnpm test' },
        }),
      );

      assert.equal(messages.length, 1);
      const [msg] = messages;
      assert.equal(msg.type, 'tool_use');
      assert.equal(msg.catId, catId);
      assert.equal(msg.toolName, 'run_command');
      assert.equal(msg.toolUseId, 'session-f325:1');
      assert.equal(msg.toolSource, 'host_cli');
      assert.deepEqual(msg.toolInput, { CommandLine: 'pnpm test' });
      assert.equal(msg.metadata, metadata);
      assert.equal(typeof msg.timestamp, 'number');
    });

    test('captures tool output on DONE step and emits tool_result message with ok status', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      progress.step(
        makeStepEvent({
          stepIndex: 1,
          state: 'ACTIVE',
          toolName: 'run_command',
          toolParameters: { CommandLine: 'echo ok' },
        }),
      );

      const doneMessages = progress.step(
        makeStepEvent({
          stepIndex: 1,
          state: 'DONE',
          toolName: 'run_command',
          toolOutput: 'ok\n',
        }),
      );

      assert.equal(doneMessages.length, 1);
      const [result] = doneMessages;
      assert.equal(result.type, 'tool_result');
      assert.equal(result.catId, catId);
      assert.equal(result.toolName, 'run_command');
      assert.equal(result.toolUseId, 'session-f325:1');
      assert.equal(result.toolSource, 'host_cli');
      assert.equal(result.content, 'ok\n');
      assert.equal(result.toolResultStatus, 'ok');
      assert.equal(result.metadata, metadata);
    });

    test('distinguishes call_mcp_tool as mcp source from ordinary host_cli tools', () => {
      const progress = new AgyNativeProgress(catId, metadata);

      const mcpMessages = progress.step(
        makeStepEvent({
          stepIndex: 1,
          state: 'ACTIVE',
          toolName: 'call_mcp_tool',
          toolParameters: { ServerName: 'cat-cafe-memory', ToolName: 'cat_cafe_list_recent', Arguments: {} },
        }),
      );
      assert.equal(mcpMessages[0]?.toolSource, 'mcp');

      const cliMessages = progress.step(
        makeStepEvent({
          stepIndex: 2,
          state: 'ACTIVE',
          toolName: 'run_command',
          toolParameters: { CommandLine: 'pwd' },
        }),
      );
      assert.equal(cliMessages[0]?.toolSource, 'host_cli');
    });

    test('is idempotent for duplicate ACTIVE and duplicate DONE events on the same stepIndex', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      const activeEvent = makeStepEvent({
        stepIndex: 1,
        state: 'ACTIVE',
        toolName: 'run_command',
        toolParameters: { CommandLine: 'date' },
      });
      const doneEvent = makeStepEvent({
        stepIndex: 1,
        state: 'DONE',
        toolName: 'run_command',
        toolOutput: 'Tue Oct 14 00:00:00 UTC 2026\n',
      });

      assert.equal(progress.step(activeEvent).length, 1);
      assert.deepEqual(progress.step(activeEvent), []);
      assert.equal(progress.step(doneEvent).length, 1);
      assert.deepEqual(progress.step(doneEvent), []);
    });

    test('handles single-shot DONE step without prior ACTIVE step', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      const messages = progress.step(
        makeStepEvent({
          stepIndex: 3,
          state: 'DONE',
          toolName: 'call_mcp_tool',
          toolParameters: { toolName: 'fast_lookup' },
          toolOutput: 'lookup result',
        }),
      );

      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.type, 'tool_use');
      assert.deepEqual(messages[0]?.toolInput, { toolName: 'fast_lookup' });
      assert.equal(messages[0]?.toolSource, 'mcp');
      assert.equal(messages[1]?.type, 'tool_result');
      assert.equal(messages[1]?.content, 'lookup result');
      assert.equal(messages[1]?.toolResultStatus, 'ok');
    });

    test('concurrently tracks different tool stepIndexes without interference', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      progress.step(makeStepEvent({ stepIndex: 10, state: 'ACTIVE', toolName: 'run_command' }));
      progress.step(makeStepEvent({ stepIndex: 20, state: 'ACTIVE', toolName: 'run_command' }));

      const done10 = progress.step(
        makeStepEvent({ stepIndex: 10, state: 'DONE', toolName: 'run_command', toolOutput: 'task 1 done' }),
      );
      const done20 = progress.step(
        makeStepEvent({ stepIndex: 20, state: 'DONE', toolName: 'run_command', toolOutput: 'task 2 done' }),
      );

      assert.equal(done10[0]?.toolUseId, 'session-f325:10');
      assert.equal(done10[0]?.content, 'task 1 done');
      assert.equal(done20[0]?.toolUseId, 'session-f325:20');
      assert.equal(done20[0]?.content, 'task 2 done');
    });
  });

  describe('normal tool failure retention', () => {
    test('preserves error outcome when tool state is ERROR', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      progress.step(makeStepEvent({ stepIndex: 1, state: 'ACTIVE', toolName: 'run_command' }));

      const messages = progress.step(
        makeStepEvent({
          stepIndex: 1,
          state: 'ERROR',
          toolName: 'run_command',
          toolOutput: null,
          toolErrorMessage: 'command not found: bad-command',
        }),
      );

      assert.equal(messages.length, 1);
      const [result] = messages;
      assert.equal(result?.type, 'tool_result');
      assert.equal(result?.toolResultStatus, 'error');
      assert.equal(result?.content, 'command not found: bad-command');
    });

    test('preserves both stdout and error cause when tool state is DONE with toolErrorMessage', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      progress.step(
        makeStepEvent({
          stepIndex: 2,
          state: 'ACTIVE',
          toolName: 'run_command',
          toolParameters: { CommandLine: 'exit 1' },
        }),
      );

      const messages = progress.step(
        makeStepEvent({
          stepIndex: 2,
          state: 'DONE',
          toolName: 'run_command',
          toolOutput: 'standard error logs',
          toolErrorMessage: 'Process exited with status 1',
        }),
      );

      assert.equal(messages.length, 1);
      const [result] = messages;
      assert.equal(result?.type, 'tool_result');
      assert.equal(result?.toolResultStatus, 'error');
      // 必须保留 stdout 输出，同时保留实际错误原因，不能在 toolOutput 非空时吞掉 toolErrorMessage
      assert.match(result?.content, /standard error logs/);
      assert.match(result?.content, /Process exited with status 1/);
    });

    test('allows streaming text and subsequent recovery steps to continue normally after tool failure', () => {
      const progress = new AgyNativeProgress(catId, metadata);

      progress.step(makeStepEvent({ stepIndex: 1, state: 'ACTIVE', toolName: 'run_command' }));
      const failResult = progress.step(
        makeStepEvent({ stepIndex: 1, state: 'ERROR', toolName: 'run_command', toolErrorMessage: 'failed' }),
      );
      assert.equal(failResult[0]?.toolResultStatus, 'error');

      const explanation = progress.step(
        makeStepEvent({
          stepIndex: 2,
          stepType: 'text',
          toolName: null,
          textDelta: 'First attempt failed, retrying with alternative...',
        }),
      );
      assert.equal(explanation.length, 1);
      assert.equal(explanation[0]?.type, 'text');
      assert.equal(explanation[0]?.content, 'First attempt failed, retrying with alternative...');

      progress.step(makeStepEvent({ stepIndex: 3, state: 'ACTIVE', toolName: 'run_command' }));
      const successResult = progress.step(
        makeStepEvent({ stepIndex: 3, state: 'DONE', toolName: 'run_command', toolOutput: 'success' }),
      );
      assert.equal(successResult[0]?.toolResultStatus, 'ok');
    });

    test('preserves terminal error and done messages in final() even when tools experienced failure', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      const finalInput = [
        { type: 'session_init', catId, sessionId: 'session-f325', metadata, timestamp: 1 },
        {
          type: 'tool_use',
          catId,
          toolName: 'run_command',
          toolUseId: 'session-f325:1',
          toolInput: {},
          toolSource: 'host_cli',
          metadata,
          timestamp: 2,
        },
        {
          type: 'tool_result',
          catId,
          toolName: 'run_command',
          toolUseId: 'session-f325:1',
          content: 'failed',
          toolResultStatus: 'error',
          metadata,
          timestamp: 3,
        },
        { type: 'error', catId, errorCode: 'AGY_TOOL_INCOMPLETE', error: 'tool failed', metadata, timestamp: 4 },
        { type: 'done', catId, errorCode: 'AGY_TOOL_INCOMPLETE', metadata, timestamp: 5 },
      ];

      const finalized = progress.final(finalInput);
      assert.equal(finalized.length, 2);
      assert.equal(finalized[0]?.type, 'error');
      assert.equal(finalized[0]?.errorCode, 'AGY_TOOL_INCOMPLETE');
      assert.equal(finalized[1]?.type, 'done');
      assert.equal(finalized[1]?.errorCode, 'AGY_TOOL_INCOMPLETE');
    });
  });

  describe('streaming text accumulation and final response deduplication', () => {
    test('accumulates streaming text chunks and yields incremental text messages', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      const chunk1 = progress.step(
        makeStepEvent({ stepIndex: 1, stepType: 'text', toolName: null, textDelta: 'Hello ' }),
      );
      const chunk2 = progress.step(
        makeStepEvent({ stepIndex: 2, stepType: 'text', toolName: null, textDelta: 'Clowder AI!' }),
      );

      assert.equal(chunk1[0]?.content, 'Hello ');
      assert.equal(chunk2[0]?.content, 'Clowder AI!');
    });

    test('deduplicates exact matching final response text against accumulated streaming text', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      progress.step(makeStepEvent({ stepIndex: 1, stepType: 'text', toolName: null, textDelta: 'Complete message' }));

      const finalInput = [
        { type: 'text', catId, content: 'Complete message', metadata, timestamp: Date.now() },
        { type: 'done', catId, metadata, timestamp: Date.now() },
      ];

      const finalized = progress.final(finalInput);
      assert.equal(finalized.length, 1);
      assert.equal(finalized[0]?.type, 'done');
    });

    test('emits replacement text with textMode replace when final snapshot differs from streamed deltas', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      progress.step(makeStepEvent({ stepIndex: 1, stepType: 'text', toolName: null, textDelta: 'Initial draft' }));

      const finalInput = [
        {
          type: 'text',
          catId,
          content: 'Initial draft with corrected ending.',
          metadata,
          timestamp: Date.now(),
        },
        { type: 'done', catId, metadata, timestamp: Date.now() },
      ];

      const finalized = progress.final(finalInput);
      assert.equal(finalized.length, 2);
      assert.equal(finalized[0]?.type, 'text');
      assert.equal(finalized[0]?.content, 'Initial draft with corrected ending.');
      assert.equal(finalized[0]?.textMode, 'replace');
      assert.equal(finalized[1]?.type, 'done');
    });

    test('preserves full text message as-is when turn had no prior streaming textDelta', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      const finalInput = [
        { type: 'text', catId, content: 'Direct non-streamed response', metadata, timestamp: Date.now() },
        { type: 'done', catId, metadata, timestamp: Date.now() },
      ];

      const finalized = progress.final(finalInput);
      assert.equal(finalized.length, 2);
      assert.equal(finalized[0]?.type, 'text');
      assert.equal(finalized[0]?.content, 'Direct non-streamed response');
      assert.equal(finalized[0]?.textMode, undefined);
      assert.equal(finalized[1]?.type, 'done');
    });

    test('strips session_init, tool_use, and tool_result while preserving terminal done', () => {
      const progress = new AgyNativeProgress(catId, metadata);
      progress.step(makeStepEvent({ stepIndex: 1, stepType: 'text', toolName: null, textDelta: 'Working...' }));

      const finalInput = [
        { type: 'session_init', catId, sessionId: 'session-f325', metadata, timestamp: 1 },
        {
          type: 'tool_use',
          catId,
          toolName: 'view_file',
          toolUseId: 'session-f325:1',
          toolInput: {},
          toolSource: 'host_cli',
          metadata,
          timestamp: 2,
        },
        {
          type: 'tool_result',
          catId,
          toolName: 'view_file',
          toolUseId: 'session-f325:1',
          content: 'content',
          toolResultStatus: 'ok',
          metadata,
          timestamp: 3,
        },
        { type: 'text', catId, content: 'Working...', metadata, timestamp: 4 },
        { type: 'done', catId, metadata, timestamp: 5 },
      ];

      const finalized = progress.final(finalInput);
      assert.equal(finalized.length, 1);
      assert.equal(finalized[0]?.type, 'done');
    });
  });

  describe('pipeline combination: parser -> projectAgyNativeTurn -> AgyNativeProgress.final', () => {
    test('retains complete final response and normal done when tool is left in ACTIVE state, marking unconfirmed tool result', () => {
      // 现场还原：工具 wait 启动处于 ACTIVE，后续无 DONE 事件，但 CLI 汇报 SUCCESS 并带完整最终回复
      const ndjsonLines = [
        JSON.stringify({
          event: 'init',
          conversation_id: 'session-f325',
          init: {
            cwd: '/workspace',
            agent: 'gemini38',
            model: 'gemini-3.8-flash-high',
            permission_mode: 'request-review',
            tools: ['wait', 'run_command'],
          },
        }),
        JSON.stringify({
          event: 'step_update',
          step_update: {
            conversation_id: 'session-f325',
            step_index: 82,
            step_type: 'tool',
            tool_name: 'wait',
            state: 'ACTIVE',
            tool_info: { parameters: { DurationSeconds: 10 } },
          },
        }),
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'session-f325',
            status: 'SUCCESS',
            response: 'Task completed successfully after wait.',
            num_turns: 1,
          },
        }),
      ];

      const turn = summarizeAgyStreamJsonTurn(ndjsonLines);
      const observed = {
        sessionId: 'session-f325',
        turn,
        transportError: null,
        cancelledBeforeTerminal: false,
      };

      const progress = new AgyNativeProgress(catId, metadata);
      // 流式阶段收到 step 82 的 ACTIVE 事件
      const streamedStep = progress.step(
        makeStepEvent({
          stepIndex: 82,
          state: 'ACTIVE',
          stepType: 'tool',
          toolName: 'wait',
          toolParameters: { DurationSeconds: 10 },
        }),
      );
      assert.equal(streamedStep.length, 1);
      assert.equal(streamedStep[0]?.type, 'tool_use');

      // 投影整个回合
      const projectedMessages = projectAgyNativeTurn(catId, metadata, observed, false, ['wait', 'run_command']);

      // 1. 未完成的工具必须以“结果未确认”的失败观察收口，不可伪造成功，也不能留空无凭证
      const toolResult = projectedMessages.find((m) => m.type === 'tool_result' && m.toolName === 'wait');
      assert.ok(toolResult, 'incomplete tool must have a tool_result observation');
      assert.equal(toolResult.toolResultStatus, 'error');
      assert.match(toolResult.content, /unconfirmed|incomplete|未确认|timeout/i);

      // 2. 终态消费：final 不得包含整轮失败错误消息
      const finalMessages = progress.final(projectedMessages);
      assert.ok(
        finalMessages.some((message) => message.type === 'tool_result' && message.toolResultStatus === 'error'),
        'the previously ACTIVE tool must visibly settle in the actual streamed pipeline',
      );
      assert.equal(
        finalMessages.some((m) => m.type === 'error'),
        false,
        'an incomplete tool observation must not fail the entire turn invocation',
      );

      // 3. 正文必须完好保留，不可被吞掉
      const textMsg = finalMessages.find((m) => m.type === 'text');
      assert.ok(textMsg, 'final response text must be retained in final messages');
      assert.equal(textMsg.content, 'Task completed successfully after wait.');

      // 4. 最终只有一次正常 done，不带错误码
      const doneMessages = finalMessages.filter((m) => m.type === 'done');
      assert.equal(doneMessages.length, 1, 'must emit exactly one terminal done');
      assert.equal(doneMessages[0]?.errorCode, undefined, 'terminal done must be normal without errorCode');
    });

    test('accurately transitions text -> tool ACTIVE -> tool DONE -> text -> final done in interleaved turn', () => {
      const progress = new AgyNativeProgress(catId, metadata);

      // 1. Initial text delta
      const t1 = progress.step(
        makeStepEvent({ stepIndex: 1, stepType: 'text', toolName: null, textDelta: 'Reading file:\n' }),
      );
      assert.equal(t1[0]?.content, 'Reading file:\n');

      // 2. Tool starts
      const tu = progress.step(
        makeStepEvent({
          stepIndex: 2,
          state: 'ACTIVE',
          stepType: 'tool',
          toolName: 'view_file',
          toolParameters: { AbsolutePath: '/workspace/doc.md' },
        }),
      );
      assert.equal(tu[0]?.type, 'tool_use');

      // 3. Tool completes
      const tr = progress.step(
        makeStepEvent({
          stepIndex: 2,
          state: 'DONE',
          stepType: 'tool',
          toolName: 'view_file',
          toolOutput: '# Markdown Title\n',
        }),
      );
      assert.equal(tr[0]?.type, 'tool_result');
      assert.equal(tr[0]?.toolResultStatus, 'ok');

      // 4. Follow-up text delta
      const t2 = progress.step(
        makeStepEvent({ stepIndex: 3, stepType: 'text', toolName: null, textDelta: 'Done reading!' }),
      );
      assert.equal(t2[0]?.content, 'Done reading!');

      // 5. Final matching turn projection
      const finalInput = [
        { type: 'session_init', catId, sessionId: 'session-f325', metadata, timestamp: 10 },
        {
          type: 'tool_use',
          catId,
          toolName: 'view_file',
          toolUseId: 'session-f325:2',
          toolInput: { AbsolutePath: '/workspace/doc.md' },
          toolSource: 'host_cli',
          metadata,
          timestamp: 11,
        },
        {
          type: 'tool_result',
          catId,
          toolName: 'view_file',
          toolUseId: 'session-f325:2',
          content: '# Markdown Title\n',
          toolResultStatus: 'ok',
          metadata,
          timestamp: 12,
        },
        { type: 'text', catId, content: 'Reading file:\nDone reading!', metadata, timestamp: 13 },
        { type: 'done', catId, metadata, timestamp: 14 },
      ];

      const finalized = progress.final(finalInput);
      assert.equal(finalized.length, 1);
      assert.equal(finalized[0]?.type, 'done');
      assert.equal(finalized[0]?.metadata, metadata);
    });
  });
});
