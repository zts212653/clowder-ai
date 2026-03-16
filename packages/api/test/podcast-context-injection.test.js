import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * F091 Phase 8: Podcast context injection tests.
 *
 * The podcast generator must inject study discussion history (thread messages)
 * and study notes into the prompt — not just the original article content.
 *
 * Root cause (铲屎官 04:36): "有问题你这个只给人发了原文？study的内容呢？"
 */

const VALID_PODCAST_JSON = JSON.stringify({
  segments: [
    { speaker: '宪宪', text: '大家好，今天我们来聊聊', durationEstimate: 10 },
    { speaker: '砚砚', text: '对，这个话题很有意思', durationEstimate: 10 },
  ],
  totalDuration: 20,
});

/** Build instrumented fake deps that capture the prompt sent to routeExecution. */
function buildCapturingDeps(callLog) {
  return {
    messageStore: {
      append(msg) {
        callLog.push({ op: 'append', content: msg.content, threadId: msg.threadId });
        return { id: 'msg-001', ...msg };
      },
      getByThread(threadId, limit) {
        callLog.push({ op: 'getByThread', threadId, limit });
        // Return simulated study thread messages
        return [
          {
            id: 'msg-study-1',
            threadId,
            userId: 'user-1',
            catId: null,
            content: '我觉得这篇文章的核心观点是分布式系统中的 CAP 定理权衡',
            mentions: [],
            timestamp: 1000,
          },
          {
            id: 'msg-study-2',
            threadId,
            userId: 'user-1',
            catId: 'opus',
            content: '确实，作者特别强调了在实际生产中，可用性通常比一致性更重要',
            mentions: [],
            timestamp: 2000,
          },
          {
            id: 'msg-study-3',
            threadId,
            userId: 'user-1',
            catId: null,
            content: '但是金融场景下一致性不能妥协',
            mentions: [],
            timestamp: 3000,
          },
        ];
      },
    },
    router: {
      async *routeExecution(_userId, message, _threadId, _userMessageId, _targetCats, _intent, _options) {
        callLog.push({
          op: 'routeExecution',
          promptReceived: message,
        });
        yield { type: 'text', content: VALID_PODCAST_JSON };
      },
    },
    invocationRecordStore: {
      create(_input) {
        callLog.push({ op: 'create' });
        return { outcome: 'created', invocationId: 'inv-001' };
      },
      update(_id, patch) {
        callLog.push({ op: 'update', ...patch });
        return {};
      },
    },
    invocationTracker: {
      start() {
        return new AbortController();
      },
      complete() {},
    },
  };
}

describe('F091 Phase 8: threadContext injection into podcast prompt', () => {
  it('buildScriptPrompt places threadContext BEFORE JSON output format', async () => {
    const { generateScriptViaThread } = await import('../dist/domains/signals/services/podcast-generator.js');
    const callLog = [];
    const deps = buildCapturingDeps(callLog);

    const request = {
      articleId: 'art-ctx-001',
      articleFilePath: '/tmp/test-context.md',
      articleTitle: 'CAP Theorem in Practice',
      articleContent: 'Distributed systems face tradeoffs between consistency and availability.',
      mode: 'essence',
      requestedBy: 'test-user',
      threadContext: '用户讨论了 CAP 定理在金融场景下的特殊需求',
    };

    await generateScriptViaThread(request, 'thread-ctx', deps);

    const appendCall = callLog.find((c) => c.op === 'append');
    assert.ok(appendCall, 'must append prompt message');
    const prompt = appendCall.content;

    // threadContext must appear in the prompt
    assert.ok(prompt.includes('CAP 定理在金融场景下的特殊需求'), 'prompt must include threadContext content');

    // threadContext must appear BEFORE the JSON output format
    const contextIdx = prompt.indexOf('之前的讨论上下文');
    const outputFormatIdx = prompt.indexOf('输出格式');
    assert.ok(contextIdx > -1, 'threadContext section must exist in prompt');
    assert.ok(outputFormatIdx > -1, 'output format section must exist in prompt');
    assert.ok(
      contextIdx < outputFormatIdx,
      `threadContext (idx=${contextIdx}) must appear BEFORE output format (idx=${outputFormatIdx})`,
    );
  });
});

describe('F091 Phase 8: route assembles threadContext from study data', () => {
  it('assembleThreadContext combines thread messages and study notes', async () => {
    const { assembleThreadContext } = await import('../dist/domains/signals/services/podcast-generator.js');

    // This function should be newly exported
    assert.ok(assembleThreadContext, 'assembleThreadContext should be exported');

    const messages = [
      { catId: null, content: '这篇文章讲了 CAP 定理', timestamp: 1000 },
      { catId: 'opus', content: '对，核心在于可用性和一致性的权衡', timestamp: 2000 },
    ];

    const studyNoteContent = '## 要点\n- CAP 定理的三个维度\n- 金融场景下一致性优先';

    const result = assembleThreadContext(messages, studyNoteContent);

    assert.ok(typeof result === 'string', 'should return a string');
    assert.ok(result.includes('CAP 定理'), 'should include message content');
    assert.ok(result.includes('可用性和一致性'), 'should include cat response content');
    assert.ok(result.includes('金融场景'), 'should include study note content');
    assert.ok(result.length > 0, 'should not be empty');
  });

  it('assembleThreadContext handles empty inputs gracefully', async () => {
    const { assembleThreadContext } = await import('../dist/domains/signals/services/podcast-generator.js');

    const result = assembleThreadContext([], undefined);
    assert.equal(result, undefined, 'should return undefined when no context available');
  });
});
