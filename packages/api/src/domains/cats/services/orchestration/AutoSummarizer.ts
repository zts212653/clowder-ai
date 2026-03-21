/**
 * Auto Summarizer
 * 对话超过阈值消息数且无近期纪要时，自动生成讨论纪要。
 *
 * 策略: 用 pattern 匹配关键句式 (结论/问题/决策)，
 * 避免额外 CLI spawn 成本。
 */

import type { ThreadSummary } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { ISummaryStore } from '../stores/ports/SummaryStore.js';

const log = createModuleLogger('auto-summarizer');

const AUTO_CREATOR = 'system' as const;
const MESSAGE_THRESHOLD = 20;
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes between auto-summaries

export interface AutoSummarizerDeps {
  messageStore: IMessageStore;
  summaryStore: ISummaryStore;
}

export class AutoSummarizer {
  private readonly messageStore: IMessageStore;
  private readonly summaryStore: ISummaryStore;
  private readonly inFlight = new Set<string>();

  constructor(deps: AutoSummarizerDeps) {
    this.messageStore = deps.messageStore;
    this.summaryStore = deps.summaryStore;
  }

  /**
   * Check if a thread needs a summary and generate one if so.
   * Returns the created summary, or null if no summary was needed.
   */
  async maybeSummarize(threadId: string): Promise<ThreadSummary | null> {
    // Prevent concurrent summarization for the same thread
    if (this.inFlight.has(threadId)) return null;
    this.inFlight.add(threadId);
    try {
      const messages = await this.messageStore.getByThread(threadId, 200);
      if (messages.length < MESSAGE_THRESHOLD) return null;

      const summaries = await this.summaryStore.listByThread(threadId);
      let recentMessages = messages;
      if (summaries.length > 0) {
        const latest = summaries[summaries.length - 1]!;
        if (Date.now() - latest.createdAt < COOLDOWN_MS) return null;
        // Only re-summarize if significant new messages since last summary
        recentMessages = messages.filter((m) => m.timestamp > latest.createdAt);
        if (recentMessages.length < MESSAGE_THRESHOLD) return null;
      }

      // P2-C fix: extract only from recent (incremental) messages
      const input = this.extractSummary(recentMessages, threadId);
      if (input) {
        return await this.summaryStore.create(input);
      }
      return null;
    } catch (err) {
      log.warn({ err }, '[auto-summary] Failed');
      return null;
    } finally {
      this.inFlight.delete(threadId);
    }
  }

  private extractSummary(
    messages: Array<{ content: string; catId: string | null; timestamp: number }>,
    threadId: string,
  ) {
    const catMessages = messages.filter((m) => m.catId && m.content.length > 20);
    if (catMessages.length === 0) return null;

    // Extract topic from first substantial message
    const firstMsg = catMessages[0]?.content;
    const topic = firstMsg.length > 60 ? `${firstMsg.slice(0, 60)}...` : firstMsg;

    // Extract conclusion-like sentences
    const conclusionPatterns = [/决定|确定|选择|采用|使用|实现了|完成了|修复了/];
    const questionPatterns = [/需要|待|TODO|还没|未来|后续|是否/];

    const conclusions: string[] = [];
    const openQuestions: string[] = [];

    for (const msg of catMessages.slice(-10)) {
      const sentences = msg.content.split(/[。！？\n]/).filter((s) => s.trim().length > 5);
      for (const s of sentences) {
        const trimmed = s.trim().slice(0, 100);
        if (conclusionPatterns.some((p) => p.test(trimmed)) && conclusions.length < 5) {
          conclusions.push(trimmed);
        } else if (questionPatterns.some((p) => p.test(trimmed)) && openQuestions.length < 3) {
          openQuestions.push(trimmed);
        }
      }
    }

    if (conclusions.length === 0 && openQuestions.length === 0) return null;

    return {
      threadId,
      topic: `自动纪要: ${topic}`,
      conclusions: conclusions.length > 0 ? conclusions : ['(暂未提取到明确结论)'],
      openQuestions,
      createdBy: AUTO_CREATOR,
    };
  }
}
