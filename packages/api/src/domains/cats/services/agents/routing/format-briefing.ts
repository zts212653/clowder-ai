// F148 Phase E: Pure function to format context briefing content.

import type { RichCardBlock, RichMessageExtra } from '@cat-cafe/shared';
import type { AppendMessageInput } from '../../stores/ports/MessageStore.js';
import type { CoverageMap } from './context-transport.js';

/** Rich block payload for frontend rendering */
export interface ContextBriefingBlock {
  type: 'context-briefing';
  coverageMap: CoverageMap;
  threadMemorySummary?: string;
  anchorSummaries?: string[];
}

/** Result from formatContextBriefing */
export interface ContextBriefingResult {
  /** One-line collapsed summary (AC-E3) */
  summary: string;
  /** Structured rich block for frontend expand view (AC-E4) */
  richBlock: ContextBriefingBlock;
}

/**
 * Format a context briefing card from a CoverageMap.
 * Pure function — no side effects, no LLM calls.
 *
 * @param coverageMap - Phase D coverage map from assembleSmartWindowContext
 * @param threadMemorySummary - Optional thread memory summary text
 * @param anchorSummaries - Optional formatted anchor summaries
 */
export function formatContextBriefing(
  coverageMap: CoverageMap,
  threadMemorySummary?: string,
  anchorSummaries?: string[],
): ContextBriefingResult {
  const parts: string[] = [];
  parts.push(`看到 ${coverageMap.burst.count} 条`);
  parts.push(`省略 ${coverageMap.omitted.count} 条`);
  parts.push(`锚点 ${coverageMap.anchorIds.length} 条`);

  if (coverageMap.threadMemory?.available) {
    parts.push(`记忆 ${coverageMap.threadMemory.sessionsIncorporated} sessions`);
  }

  parts.push(`证据 ${coverageMap.retrievalHints.length} 条`);

  const summary = parts.join(' · ');

  const richBlock: ContextBriefingBlock = {
    type: 'context-briefing',
    coverageMap,
    ...(threadMemorySummary ? { threadMemorySummary } : {}),
    ...(anchorSummaries?.length ? { anchorSummaries } : {}),
  };

  return { summary, richBlock };
}

/** Options for buildBriefingMessage */
interface BriefingMessageOptions {
  threadMemorySummary?: string;
  anchorSummaries?: string[];
}

/**
 * Build an AppendMessageInput for the briefing card.
 * The caller (route-serial/route-parallel) appends this to messageStore
 * and yields it as system_info for frontend display.
 */
export function buildBriefingMessage(
  coverageMap: CoverageMap,
  threadId: string,
  options?: BriefingMessageOptions,
): AppendMessageInput {
  const { summary, richBlock } = formatContextBriefing(
    coverageMap,
    options?.threadMemorySummary,
    options?.anchorSummaries,
  );

  // Build expanded bodyMarkdown for AC-E4
  const bodyParts: string[] = [];
  if (coverageMap.omitted.participants.length > 0) {
    bodyParts.push(`**参与者**: ${coverageMap.omitted.participants.join(', ')}`);
  }
  const from = new Date(coverageMap.omitted.timeRange.from).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const to = new Date(coverageMap.burst.timeRange.to).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (coverageMap.omitted.timeRange.from > 0) {
    bodyParts.push(`**时间范围**: ${from} — ${to}`);
  }
  if (options?.anchorSummaries?.length) {
    bodyParts.push(`**锚点**:\n${options.anchorSummaries.map((a) => `- ${a}`).join('\n')}`);
  }
  if (options?.threadMemorySummary) {
    bodyParts.push(`**线程记忆**:\n${options.threadMemorySummary}`);
  }
  // VG-3: Key decisions from threadMemory
  if (coverageMap.threadMemory?.decisions?.length) {
    const top3 = coverageMap.threadMemory.decisions.slice(0, 3);
    bodyParts.push(`**关键决策**:\n${top3.map((d) => `- ${d}`).join('\n')}`);
  }
  if (coverageMap.threadMemory?.openQuestions?.length) {
    const top2 = coverageMap.threadMemory.openQuestions.slice(0, 2);
    bodyParts.push(`**待决问题**:\n${top2.map((q) => `- ${q}`).join('\n')}`);
  }
  if (coverageMap.retrievalHints.length > 0) {
    bodyParts.push(`**证据召回**:\n${coverageMap.retrievalHints.map((h) => `- ${h}`).join('\n')}`);
  }
  if (coverageMap.searchSuggestions?.length) {
    bodyParts.push(
      `**深入搜索**:\n${coverageMap.searchSuggestions.map((s) => `- \`${s.replace(/[`\n\r\\]/g, ' ').trim()}\``).join('\n')}`,
    );
  }

  const card: RichCardBlock = {
    id: 'briefing-1',
    kind: 'card',
    v: 1,
    title: summary,
    tone: 'info',
    bodyMarkdown: bodyParts.length > 0 ? bodyParts.join('\n\n') : undefined,
    fields: [
      { label: '参与者', value: coverageMap.omitted.participants.join(', ') || '—' },
      { label: '省略消息', value: `${coverageMap.omitted.count} 条` },
      { label: '看到消息', value: `${coverageMap.burst.count} 条` },
    ],
  };

  const rich: RichMessageExtra = { v: 1, blocks: [card] };

  return {
    threadId,
    userId: 'system',
    catId: null,
    content: summary,
    mentions: [],
    timestamp: Date.now(),
    origin: 'briefing',
    extra: { rich },
  };
}
