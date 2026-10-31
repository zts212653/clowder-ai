/**
 * AutoSummarizer Tests — Red→Green for bug report:
 * - P1-A: createdBy must NOT be 'opus'; should be 'system'
 * - P2-C: extraction window should use only recent (incremental) messages
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AutoSummarizer } = await import('../dist/domains/cats/services/orchestration/AutoSummarizer.js');
const { SummaryStore } = await import('../dist/domains/cats/services/stores/ports/SummaryStore.js');

/**
 * Minimal in-memory message store stub for testing.
 */
function createMockMessageStore(messages = []) {
  return {
    getById: () => null,
    getByThread: () => messages,
  };
}

function makeCatMessage(content, catId = 'opus', timestamp = Date.now()) {
  return { id: `msg-${timestamp}`, content, catId, timestamp, userId: 'user-1', threadId: 'thread-1', mentions: [] };
}

describe('AutoSummarizer', () => {
  describe('P1-A: createdBy attribution', () => {
    it('auto-summary createdBy should be "system", never a cat ID', async () => {
      const now = Date.now();
      // Generate 25 messages with conclusion-like content
      const messages = [];
      for (let i = 0; i < 25; i++) {
        messages.push(
          makeCatMessage(
            i === 20 ? '我们决定采用 CLI 子进程模式来实现 agent 调用' : `这是第 ${i} 条测试消息，内容需要超过20个字符`,
            'opus',
            now + i * 1000,
          ),
        );
      }

      const messageStore = createMockMessageStore(messages);
      const summaryStore = new SummaryStore();
      const summarizer = new AutoSummarizer({ messageStore, summaryStore });

      const summary = await summarizer.maybeSummarize('thread-1');

      assert.ok(summary, 'should have generated a summary');
      assert.equal(summary.createdBy, 'system', 'auto-summary must be attributed to "system"');
      assert.notEqual(summary.createdBy, 'opus', 'auto-summary must NOT be attributed to opus');
    });
  });

  describe('P2-C: incremental extraction window', () => {
    it('should extract from recent messages only when prior summary exists', async () => {
      const now = Date.now();
      const oldTimestamp = now - 20 * 60 * 1000; // 20 min ago (past cooldown)

      // Phase 1: old messages with an old topic
      const oldMessages = [];
      for (let i = 0; i < 25; i++) {
        oldMessages.push(
          makeCatMessage(
            i === 0 ? '讨论旧话题：我们确定要使用 Redis 作为持久化层' : `旧话题消息 ${i}，内容需要超过二十个字符`,
            'codex',
            oldTimestamp + i * 1000,
          ),
        );
      }

      // Pre-seed a summary from the old window (simulates first auto-summary)
      const summaryStore = new SummaryStore();
      const oldSummary = summaryStore.create({
        threadId: 'thread-1',
        topic: '旧纪要',
        conclusions: ['旧结论'],
        openQuestions: [],
        createdBy: 'system',
      });
      // Hack: backdate the summary so cooldown has elapsed
      Object.defineProperty(oldSummary, 'createdAt', { value: oldTimestamp + 24 * 1000, writable: false });

      // All messages: old + new
      const allMessages = [...oldMessages];
      for (let i = 0; i < 25; i++) {
        allMessages.push(
          makeCatMessage(
            i === 0 ? '新话题：我们选择 Fastify 作为 HTTP 框架' : `新话题消息 ${i}，内容也需要超过二十个字符`,
            'opus',
            now + i * 1000,
          ),
        );
      }

      const messageStore = createMockMessageStore(allMessages);
      const summarizer = new AutoSummarizer({ messageStore, summaryStore });

      // Generate second summary — should only extract from new messages
      const secondSummary = await summarizer.maybeSummarize('thread-1');
      assert.ok(secondSummary, 'should have generated second summary');
      assert.ok(
        secondSummary.topic.includes('新话题'),
        `topic should come from new messages window, got: "${secondSummary.topic}"`,
      );
      assert.ok(!secondSummary.topic.includes('旧话题'), 'topic should NOT come from old messages');
    });
  });

  describe('should not summarize below threshold', () => {
    it('returns null when fewer than 20 messages', async () => {
      const messages = [];
      for (let i = 0; i < 15; i++) {
        messages.push(makeCatMessage(`消息 ${i} 内容需要超过二十个字符`, 'opus', Date.now() + i * 1000));
      }

      const summarizer = new AutoSummarizer({
        messageStore: createMockMessageStore(messages),
        summaryStore: new SummaryStore(),
      });

      const result = await summarizer.maybeSummarize('thread-1');
      assert.equal(result, null);
    });
  });
});
