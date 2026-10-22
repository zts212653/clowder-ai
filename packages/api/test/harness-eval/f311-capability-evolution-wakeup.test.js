import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getCapabilityWakeupRules } from '../../dist/infrastructure/harness-eval/capability-wakeup/capability-wakeup-rules.js';
import {
  buildCapabilityTrace,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-adapter.js';
import { toolEvent, transcriptEvent } from './capability-wakeup-test-helpers.js';

const ruleId = 'capability-evolution-concrete-target';

function traceFor(text, tool) {
  const invocationId = 'inv-f311-capability-evolution';
  return buildCapabilityTrace({
    sessionId: 'session-cap',
    threadId: 'thread-cap',
    catId: 'gpt52',
    transcriptEvents: [
      transcriptEvent(0, invocationId, {
        type: 'text',
        content: 'I will answer the request and use the appropriate capability when needed.',
      }),
    ],
    promptEvents: [
      {
        invocationId,
        sourceMessageId: 'message-f311-prompt',
        timestamp: Date.now(),
        content: text,
      },
    ],
    toolEvents: tool
      ? [
          toolEvent({
            invocationId,
            toolName: 'cat_cafe_start_evolution_program',
            status: tool.status,
            summary: tool.summary,
          }),
        ]
      : [],
  });
}

describe('F311 capability evolution trace evaluation', () => {
  it('does not turn informational prompts into a Program-creation opportunity', () => {
    const rules = getCapabilityWakeupRules({ ruleIds: [ruleId] });
    assert.equal(rules.length, 1, `missing ${ruleId}`);
    for (const prompt of [
      '我们来进化 嗯？ 你们能自进化什么东西？',
      '我们来进化什么能力',
      '我们来进化 能进化哪些东西',
    ]) {
      assert.deepEqual(evaluateCapabilityWakeupTrace(traceFor(prompt), rules), [], prompt);
    }
  });

  it('does not count quoted, deferred, or truncated mentions as concrete targets', () => {
    const rules = getCapabilityWakeupRules({ ruleIds: [ruleId] });
    for (const prompt of [
      '刚才我们来进化 这个提法我觉得挺好，明天再说。',
      '他的 skill 说用户讲我们来进化 X 时才创建 Program，我核过了没问题。',
      `我们来进化${'能力'.repeat(135)}…`,
    ]) {
      assert.deepEqual(evaluateCapabilityWakeupTrace(traceFor(prompt), rules), [], prompt);
    }
  });

  it('counts a concrete target without the canonical start tool as a miss', () => {
    const rules = getCapabilityWakeupRules({ ruleIds: [ruleId] });
    const trials = evaluateCapabilityWakeupTrace(traceFor('我们来进化视频生成能力'), rules);
    assert.equal(trials.length, 1);
    assert.equal(trials[0].capability, 'capability-evolution');
    assert.equal(trials[0].outcome, 'miss');
  });

  it('does not let the mechanical denominator infer direct business-goal semantics', () => {
    const rules = getCapabilityWakeupRules({ ruleIds: [ruleId] });
    for (const prompt of [
      '让 PM Agent 专业地推进项目，只在必要时请人介入',
      '让 PM Agent 专业地推进项目，如果我确认风险后我在评估后通知客服智能体说我决定是否启动，只在必要时请人介入。',
    ]) {
      assert.deepEqual(evaluateCapabilityWakeupTrace(traceFor(prompt), rules), [], prompt);
    }
  });

  it('counts only a successful canonical start as capability use', () => {
    const rules = getCapabilityWakeupRules({ ruleIds: [ruleId] });
    const success = evaluateCapabilityWakeupTrace(
      traceFor('我们来进化视频生成能力', { status: 'success', summary: { ok: true } }),
      rules,
    );
    assert.equal(success.length, 1);
    assert.equal(success[0].outcome, 'negative');
    assert.match(success[0].usageEvidence[0], /cat_cafe_start_evolution_program/u);

    const failure = evaluateCapabilityWakeupTrace(
      traceFor('我们来进化视频生成能力', {
        status: 'error',
        summary: { isError: true, error: 'invalid target' },
      }),
      rules,
    );
    assert.equal(failure.length, 1);
    assert.equal(failure[0].outcome, 'miss');
  });
});
