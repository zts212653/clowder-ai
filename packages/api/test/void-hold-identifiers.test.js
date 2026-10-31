import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateVoidHold } from '../dist/domains/cats/services/agents/routing/void-hold-detect.js';

const noExit = { toolNames: [], lineStartMentions: [], structuredTargetCats: [] };
const taskId = 'hold-ball-1791995038677-fp6czv';

describe('F325 Alpha: completed command receipts do not declare a new hold', () => {
  test('the actual completed reply routing paragraph needs no new hold', () => {
    const reply = [
      '托管的实际回归任务已执行完毕，回归演练与验收结果汇报如下：',
      '',
      '### 3. 托管回执',
      `- **Task ID**: \`${taskId}\``,
      '- **Job ID**: `managed-job-a406ce6c5a4acea2accfa7351f17af0fbd522d48`',
      '- **生命周期状态**: 原消息的执行结果已持久化为 completed。',
      '- **隔离约定**: 本轮为独立的 Alpha 验收回归，未触碰原现场 Task2347，未触碰正式 runtime，未引入其他猫。',
      '',
      '[烁烁/Gemini 3.8 Flash🐾]',
    ].join('\n');
    assert.deepEqual(evaluateVoidHold({ ...noExit, text: reply, toolNames: [] }), {
      shouldEmit: false,
      matchedPattern: null,
    });
  });

  for (const text of [
    `Task ID: ${taskId}`,
    `Completed task \`${taskId}\`.`,
    'Artifact identifier: holdXball',
    'Property: holding.the.ball',
  ]) {
    test(`literal identifier is not an English hold phrase: ${text}`, () => {
      assert.equal(evaluateVoidHold({ ...noExit, text }).shouldEmit, false);
    });
  }

  for (const [text, trigger] of [
    [`${taskId} 已完成，我持球等新的条件。`, 'cn_wo_chi_qiu'],
    [`${taskId} completed; I will hold ball for the next signal.`, 'en_holdball_space'],
    ['I will HOLD  BALL while waiting.', 'en_holdball_space'],
    ['I am holding\tthe  ball until the callback.', 'en_holding_the_ball'],
    ['I will `hold_ball` until the next signal.', 'en_hold_ball_underscore'],
    ['准备调用 cat_cafe_hold_ball 但还没动', 'mcp_tool_name'],
  ]) {
    test(`a real unbacked declaration still warns: ${text}`, () => {
      assert.deepEqual(evaluateVoidHold({ ...noExit, text }), { shouldEmit: true, matchedPattern: trigger });
    });
  }
});
