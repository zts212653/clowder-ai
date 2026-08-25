// F148 Phase E: Pure function to format context briefing content.

import type { RichCardBlock, RichMessageExtra } from '@cat-cafe/shared';
import { getCoCreatorConfig } from '../../../../../config/cat-config-loader.js';
import { formatInjectionProvenance } from '../../../../memory/injection-provenance.js';
import { formatPromptTime, formatPromptTimeRange } from '../../format-time.js';
import type { ContextSurfaceProjection } from '../../session/context-surface-projection.js';
import type { AppendMessageInput } from '../../stores/ports/MessageStore.js';
import type { RecentArtifact } from './artifact-tracking.js';
import type { CoverageMap } from './context-transport.js';
import type { BatonContext, TaskSummary } from './navigation-context.js';
import { type RankedSource, selectDirectiveSources } from './source-ranking.js';
import { formatThreadDrill } from './thread-drill-pointer.js';

/** Rich block payload for frontend rendering */
export interface ContextBriefingBlock {
  type: 'context-briefing';
  coverageMap: CoverageMap;
  threadMemorySummary?: string;
  anchorSummaries?: string[];
  baton?: BatonContext;
  activeTasks?: TaskSummary[];
  /** F296 B3b-4: copied from the route projection; the card never re-derives continuity. */
  contextSurfaceProjection?: ContextSurfaceProjection;
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
  contextSurfaceProjection?: ContextSurfaceProjection,
): ContextBriefingResult {
  const parts: string[] = [];
  parts.push(`看到 ${coverageMap.burst.count} 条`);
  parts.push(`省略 ${coverageMap.omitted.count} 条`);
  parts.push(`锚点 ${coverageMap.anchorIds.length} 条`);

  if (coverageMap.threadMemory?.available) {
    parts.push(`记忆 ${coverageMap.threadMemory.sessionsIncorporated} sessions`);
  }

  parts.push(`证据指针 ${coverageMap.recallPointer.candidateCount} 条`);

  if (contextSurfaceProjection) {
    parts.push(`${contextSurfaceProjection.contextMode}/${contextSurfaceProjection.reason}`);
    const counts = contextSurfaceProjection.presentationCounts;
    parts.push(`T0 ${counts.T0} · T1 ${counts.T1} · T2 ${counts.T2} · invalid ${counts.invalid}`);
  }

  const summary = parts.join(' · ');

  const richBlock: ContextBriefingBlock = {
    type: 'context-briefing',
    coverageMap,
    ...(threadMemorySummary ? { threadMemorySummary } : {}),
    ...(anchorSummaries?.length ? { anchorSummaries } : {}),
    ...(contextSurfaceProjection ? { contextSurfaceProjection } : {}),
  };

  return { summary, richBlock };
}

function formatBatonField(baton?: BatonContext): string {
  if (!baton) return '直接 @';
  const timeStr = formatPromptTime(baton.timestamp, { timeZone: getCoCreatorConfig().timeZone });
  let value = `${baton.fromSpeakerDisplay} → 你 (${timeStr})`;
  if (baton.staleHoldWarning) value += ' ⚠️';
  return value;
}

function formatSourceField(sources: RankedSource[] | undefined, threadId: string): string {
  const top = sources ? selectDirectiveSources(sources)[0] : undefined;
  return top ? `${top.label} — ${top.ref}` : `未定位（threadId=${threadId}）`;
}

function formatNextStepField(threadId: string, sources?: RankedSource[], semanticSearchTerms?: string[]): string {
  const top = sources ? selectDirectiveSources(sources)[0] : undefined;
  if (top) return `先看 ${top.label}: ${top.ref}`;
  return formatThreadDrill(threadId, semanticSearchTerms);
}

function buildNavigationTitle(threadId: string, baton?: BatonContext, sources?: RankedSource[]): string {
  const parts: string[] = [];
  if (baton) parts.push(`${baton.fromSpeakerDisplay} → 你`);
  parts.push(`真相源: ${formatSourceField(sources, threadId)}`);
  return parts.join(' · ');
}

function formatContextCoordinate(projection: ContextSurfaceProjection): string {
  const carrier = projection.coordinate.providerCarrier;
  return `${carrier.provider}/${carrier.carrier} · ${projection.coordinate.invocationOrigin} · ${projection.coordinate.routeTopology}`;
}

function formatContextMode(projection: ContextSurfaceProjection): string {
  return `${projection.contextMode} · ${projection.reason} · epoch ${projection.contextEpoch} · ${projection.deltaSize}`;
}

function formatPresentationCounts(projection: ContextSurfaceProjection): string {
  const counts = projection.presentationCounts;
  return `T0 ${counts.T0} · T1 ${counts.T1} · T2 ${counts.T2} · invalid ${counts.invalid}`;
}

/** Options for buildBriefingMessage */
interface BriefingMessageOptions {
  threadMemorySummary?: string;
  anchorSummaries?: string[];
  baton?: BatonContext;
  activeTasks?: TaskSummary[];
  recentArtifacts?: RecentArtifact[];
  rankedSources?: RankedSource[];
  contextSurfaceProjection?: ContextSurfaceProjection;
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
    options?.contextSurfaceProjection,
  );

  // Build expanded bodyMarkdown for AC-E4
  const bodyParts: string[] = [];
  if (coverageMap.omitted.participants.length > 0) {
    bodyParts.push(`**参与者**: ${coverageMap.omitted.participants.join(', ')}`);
  }
  if (coverageMap.omitted.timeRange.from > 0) {
    bodyParts.push(
      `**时间范围**: ${formatPromptTimeRange(coverageMap.omitted.timeRange.from, coverageMap.burst.timeRange.to)}`,
    );
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
    bodyParts.push(
      `**关键决策**:\n${top3
        .map((decision, index) => {
          const ref = coverageMap.threadMemory?.decisionRefs?.[index] ?? { threadId };
          return `- ${decision} ${formatInjectionProvenance(ref)}`;
        })
        .join('\n')}`,
    );
  }
  // F296 AC-A2: no 待决问题 block. The regex/summary openQuestions have no
  // canonical lifecycle state and no invalidator, so a closed question would keep
  // presenting itself as current work — on the card and, since the briefing is
  // persisted as a thread message, in later prompts too.
  if (options?.baton) {
    const b = options.baton;
    const timeStr = formatPromptTime(b.timestamp, { timeZone: getCoCreatorConfig().timeZone });
    let batonLine = `**传球**: ${b.fromSpeakerDisplay} → 你 (${timeStr})`;
    if (b.mentionExcerpt) batonLine += ` | 原文: "${b.mentionExcerpt}"`;
    if (b.staleHoldWarning) batonLine += ' ⚠️ 之前有"别动"指令';
    bodyParts.push(batonLine);
  }
  if (options?.activeTasks?.length) {
    const taskLines = options.activeTasks.map((t) => {
      const owner = t.ownerCatId ? `@${t.ownerCatId}` : '未分配';
      return `- [${t.status}] ${t.title} (${owner})`;
    });
    bodyParts.push(`**活跃任务**:\n${taskLines.join('\n')}`);
  }
  if (options?.recentArtifacts?.length) {
    const artifactLines = options.recentArtifacts.map((a) => `- [${a.type}] ${a.label} (${a.updatedBy})`);
    bodyParts.push(`**最近产物**:\n${artifactLines.join('\n')}`);
  }
  const directiveSources = options?.rankedSources ? selectDirectiveSources(options.rankedSources) : [];
  if (directiveSources.length) {
    const sourceLines = directiveSources.map((s) => `- [${s.type}] ${s.label} — ${s.ref}`);
    bodyParts.push(`**真相源**:\n${sourceLines.join('\n')}`);
  }
  if (coverageMap.recallPointer.candidateCount > 0) {
    // F296 AC-A1: pointer only — the card mirrors what the cat actually got.
    bodyParts.push(
      `**证据召回**: ${coverageMap.recallPointer.candidateCount} 条启发式候选未展开正文，需要时用 \`cat_cafe_search_evidence\` 自行检索`,
    );
  }
  if (coverageMap.searchSuggestions?.length) {
    bodyParts.push(
      `**深入搜索**:\n${coverageMap.searchSuggestions.map((s) => `- \`${s.replace(/[`\n\r\\]/g, ' ').trim()}\``).join('\n')}`,
    );
  }

  const navTitle = buildNavigationTitle(threadId, options?.baton, options?.rankedSources);

  const card: RichCardBlock = {
    id: 'briefing-1',
    kind: 'card',
    v: 1,
    title: navTitle,
    tone: 'info',
    bodyMarkdown: bodyParts.length > 0 ? bodyParts.join('\n\n') : undefined,
    fields: [
      { label: '传球', value: formatBatonField(options?.baton) },
      { label: '真相源', value: formatSourceField(options?.rankedSources, threadId) },
      {
        label: '下一步',
        value: formatNextStepField(threadId, options?.rankedSources, coverageMap.semanticSearchTerms),
      },
      ...(options?.contextSurfaceProjection
        ? [
            {
              label: '坐标',
              value: formatContextCoordinate(options.contextSurfaceProjection),
            },
            {
              label: '上下文',
              value: formatContextMode(options.contextSurfaceProjection),
            },
            {
              label: '呈现',
              value: formatPresentationCounts(options.contextSurfaceProjection),
            },
          ]
        : []),
    ],
    ...(options?.contextSurfaceProjection
      ? {
          meta: {
            kind: 'context_briefing',
            contextSurfaceProjection: options.contextSurfaceProjection,
          },
        }
      : {}),
  };

  const rich: RichMessageExtra = { v: 1, blocks: [card] };

  return {
    threadId,
    userId: 'system',
    catId: null,
    content: navTitle,
    mentions: [],
    timestamp: Date.now(),
    origin: 'briefing',
    extra: { rich, systemKind: 'context_briefing' },
  };
}
