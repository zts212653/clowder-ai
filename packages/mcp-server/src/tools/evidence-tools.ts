/**
 * Evidence Search Tool
 * MCP 工具: 搜索项目知识 (SQLite FTS5 + semantic rerank)
 *
 * F102 Phase D: 统一检索入口。支持 scope/mode/depth 分层。
 * 不依赖 callback 鉴权 — evidence 路由是公开 GET。
 */

import {
  formatRecallMeta,
  type RecallMatchRank,
  type RecallPreviewItem,
  type SuggestedCrossPostAction,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { formatSuggestedCrossPostActionLines } from './cross-post-suggestion-format.js';
import { composeCoverageIntentNudge } from './evidence-coverage-nudge.js';
import { type CoverageToolData, renderCoverageToolResponse } from './evidence-coverage-response.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';
const COVERAGE_OUTER_HTTP_BUDGET_MS = 16_000;

const DOC_SOURCE_TYPES = new Set(['feature', 'decision', 'phase', 'architecture', 'lesson', 'plan', 'research']);
const EVIDENCE_RESULT_MARKER = 'Evidence search results:';
let searchCount = 0;

type EvidenceEntityMatch = {
  entityId: string;
  type?: string;
  canonicalName?: string;
  matchedAlias?: string;
  surface?: string;
  source?: string;
  docAnchor?: string;
  passageId?: string;
  why?: string;
  provenance?: Array<{ source?: string; anchor?: string; note?: string; date?: string }>;
};

type EvidenceDrillDown = {
  tool: string;
  params?: Record<string, string>;
  hint?: string;
};

export const searchEvidenceInputSchema = {
  query: z.string().min(1).max(2_000).describe('Search query for project knowledge (max 2,000 characters)'),
  limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
  scope: z
    .enum(['docs', 'memory', 'threads', 'sessions', 'all'])
    .optional()
    .describe(
      'Collection scope: docs (features/ADRs/plans/lessons), threads/sessions (chat history), all (everything)',
    ),
  mode: z
    .enum(['lexical', 'semantic', 'hybrid'])
    .optional()
    .describe('Retrieval mode: lexical (BM25, default), semantic (vector), hybrid (both + rerank)'),
  depth: z.enum(['summary', 'raw']).optional().describe('Result depth: summary (default) or raw detail'),
  dateFrom: z.string().optional().describe('ISO8601 date filter, inclusive lower bound (e.g. 2026-03-15)'),
  dateTo: z.string().optional().describe('ISO8601 date filter, inclusive upper bound (e.g. 2026-03-20)'),
  contextWindow: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe('Number of surrounding passages to include per match (like grep -C). Only effective with depth=raw'),
  threadId: z
    .string()
    .optional()
    .describe(
      'Filter results to a specific thread. Only returns evidence from that thread digest. For reading raw messages, use get_thread_context instead.',
    ),
  dimension: z
    .enum(['project', 'global', 'library', 'collection', 'all'])
    .optional()
    .describe(
      'Knowledge dimension: project (default, local docs), library (all registered collections incl. external), collection (specific collections via collections param), all (DEPRECATED legacy alias for project+global — use library or collection for multi-collection search)',
    ),
  collections: z
    .string()
    .optional()
    .describe(
      'Comma-separated collection IDs to search (e.g. "world:lexander,global:methods"). Only effective with dimension=collection',
    ),
  explain: z
    .boolean()
    .optional()
    .describe('When true, include rankingFactors (bm25Score, consumptionPrior, mmrPenalty) on each result'),
  intent: z
    .enum(['topk', 'coverage'])
    .optional()
    .describe(
      'Search intent: topk (default, ranked list) or coverage (exhaustive multi-scope search with coverage matrix output). Use coverage for "哪些/所有/历史上" style source-map queries.',
    ),
  coverage_offset: z
    .number()
    .int()
    .min(0)
    .max(49)
    .optional()
    .describe(
      'Continuation offset from a truncated coverage response drill pointer. Only effective with intent=coverage.',
    ),
  include_expansion: z
    .boolean()
    .optional()
    .describe(
      'F256 Phase B: Include expansion hints ("Related directions") in topk results. Default true. Set false to suppress.',
    ),
};

export interface EvidenceToolCallExtra {
  signal?: AbortSignal;
}

export async function handleSearchEvidence(
  input: {
    query: string;
    limit?: number | undefined;
    scope?: string | undefined;
    mode?: string | undefined;
    depth?: string | undefined;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    contextWindow?: number | undefined;
    threadId?: string | undefined;
    dimension?: string | undefined;
    collections?: string | undefined;
    explain?: boolean | undefined;
    intent?: 'topk' | 'coverage' | undefined;
    coverage_offset?: number | undefined;
    include_expansion?: boolean | undefined;
  },
  extra?: EvidenceToolCallExtra,
): Promise<ToolResult> {
  const { dimension = 'project' } = input;
  const params = new URLSearchParams({ q: input.query });
  if (input.limit != null) params.set('limit', String(input.limit));
  if (input.scope) params.set('scope', input.scope);
  if (input.mode) params.set('mode', input.mode);
  if (input.depth) params.set('depth', input.depth);
  if (input.dateFrom) params.set('dateFrom', input.dateFrom);
  if (input.dateTo) params.set('dateTo', input.dateTo);
  if (input.contextWindow != null) params.set('contextWindow', String(input.contextWindow));
  if (input.threadId) params.set('threadId', input.threadId);
  const currentThreadId = process.env['CAT_CAFE_THREAD_ID']?.trim();
  if (currentThreadId) params.set('currentThreadId', currentThreadId);
  params.set('dimension', dimension);
  if (input.collections) params.set('collections', input.collections);
  if (input.explain) params.set('explain', 'true');
  if (input.intent) params.set('intent', input.intent);
  if (input.coverage_offset != null) params.set('coverage_offset', String(input.coverage_offset));
  if (input.include_expansion === false) params.set('include_expansion', 'false');

  const url = `${API_URL}/api/evidence/search?${params.toString()}`;
  const queryLabel = JSON.stringify(input.query);
  const outerDeadlineSignal =
    input.intent === 'coverage' ? AbortSignal.timeout(COVERAGE_OUTER_HTTP_BUDGET_MS) : undefined;
  const requestSignal =
    outerDeadlineSignal && extra?.signal
      ? AbortSignal.any([outerDeadlineSignal, extra.signal])
      : (outerDeadlineSignal ?? extra?.signal);

  try {
    const userId = process.env['CAT_CAFE_USER_ID']?.trim();
    const internalHeaders: Record<string, string> = {};
    if (userId) internalHeaders['x-cat-cafe-user'] = userId;
    if (currentThreadId) internalHeaders['x-cat-cafe-thread-id'] = currentThreadId;
    const response = await fetch(url, {
      headers: Object.keys(internalHeaders).length > 0 ? internalHeaders : undefined,
      signal: requestSignal,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(
        `[cat-cafe-search-evidence] HTTP error ${response.status} for ${url}\n  query=${queryLabel}\n  body=${text.slice(0, 500)}`,
      );
      if (input.intent === 'coverage' && response.status === 408) {
        return recallErrorResult(
          `Coverage search failed for ${queryLabel}: outer HTTP 408; the upstream request was cancelled or aborted.`,
          'Retry with a narrower scope (docs or threads) or a narrower query; inspect coverage stage telemetry if it repeats.',
        );
      }
      return recallErrorResult(
        `Evidence search failed for ${queryLabel} (${response.status}): ${text}`,
        'Evidence search failed before results were returned. Check the API error and retry after fixing the service.',
      );
    }

    // F200 HW-1: intent=coverage returns CoverageSearchResult (different shape from topk)
    if (input.intent === 'coverage') {
      return renderCoverageToolResponse((await response.json()) as CoverageToolData, input, queryLabel);
    }

    const data = (await response.json()) as {
      results: Array<{
        title: string;
        anchor: string;
        snippet: string;
        matchRank: 'high' | 'mid' | 'low';
        retrievalScore?: number;
        sourceType: string;
        status?: string;
        authority?: string;
        updatedAt?: string;
        boostSource?: string[];
        matchReason?: string;
        entityMatches?: EvidenceEntityMatch[];
        drillDown?: EvidenceDrillDown;
        sourcePath?: string;
        rankingFactors?: { bm25Score?: number; consumptionPrior?: number; mmrPenalty?: number };
        suggestedAction?: SuggestedCrossPostAction;
        passages?: Array<{
          docAnchor?: string;
          passageId: string;
          content: string;
          speaker?: string;
          createdAt?: string;
          threadId?: string;
          messageId?: string;
          context?: Array<{
            docAnchor?: string;
            passageId: string;
            content: string;
            speaker?: string;
            createdAt?: string;
            threadId?: string;
            messageId?: string;
          }>;
        }>;
      }>;
      degraded: boolean;
      degradeReason?: string;
      effectiveMode?: 'lexical' | 'semantic' | 'hybrid';
      variantId?: string;
      filterExecution?: {
        requestedThreadId: string;
        executedThreadId: string;
        outcome: 'matched' | 'authoritative_empty' | 'degraded_empty';
      };
      /** F256 Phase B: expansion hints from TopkExpansionService */
      expansionHints?: Array<{
        anchor: string;
        title: string;
        kind: string;
        sourcePath?: string;
        provenance?: { source: string; via: string; edgeStrength: string };
      }>;
    };

    const degradedBanner = formatDegradedBanner(data.degraded, data.degradeReason, data.effectiveMode);

    // Hook F-3: search depth tracking runs on ALL searches including empty results
    searchCount++;
    const depthLine = `📊 本轮第 ${searchCount} 次搜索 | 搜到 doc anchor → Read 源文件，不要用摘要推理`;
    const docHitsForTelemetry = data.results.filter(
      (r) => (r.matchRank === 'high' || r.matchRank === 'mid') && DOC_SOURCE_TYPES.has(r.sourceType),
    );
    console.error(
      `[cat-cafe-search-depth] ${JSON.stringify({
        metric: 'search_depth',
        searchCount,
        resultCount: data.results.length,
        docHitCount: docHitsForTelemetry.length,
        scope: input.scope ?? 'all',
        mode: input.mode ?? 'lexical',
      })}`,
    );

    if (data.results.length === 0) {
      const noResultMsg = `${EVIDENCE_RESULT_MARKER} No results found for: ${input.query}`;
      const filterExecutionLine = formatThreadFilterExecution(data.filterExecution);
      const nudge = composeMemoryNavigationNudge(data); // F188 AC-F3 + KD-7
      const coverageNudge = composeCoverageIntentNudge(input.query);
      const parts = [
        degradedBanner,
        noResultMsg,
        filterExecutionLine,
        nudge,
        coverageNudge,
        depthLine,
        formatRecallMeta({
          resultStatus: 'no_results',
          resultCount: 0,
          degraded: data.degraded,
          ...(data.degradeReason ? { degradeReason: data.degradeReason } : {}),
          readNextHint: 'No search results were returned. Try graph_resolve/list_recent or broaden the query.',
        }),
      ].filter(Boolean);
      return successResult(parts.join('\n\n'));
    }

    const lines: string[] = [];
    if (degradedBanner) {
      lines.push(degradedBanner);
      lines.push('');
    }

    lines.push(
      `${EVIDENCE_RESULT_MARKER} Found ${data.results.length} result(s) for ${queryLabel}${
        data.variantId ? ` [variant=${data.variantId}]` : ''
      }:`,
    );
    lines.push('');
    const filterExecutionLine = formatThreadFilterExecution(data.filterExecution);
    if (filterExecutionLine) {
      lines.push(filterExecutionLine);
      lines.push('');
    }

    for (const r of data.results) {
      lines.push(
        `[match:${r.matchRank} · authority:${r.authority ?? 'unknown'} · updated:${r.updatedAt ?? 'unknown'}] ${r.title}`,
      );
      lines.push(`  anchor: ${r.anchor}`);
      lines.push(`  type: ${r.sourceType}`);
      if (r.status) lines.push(`  status: ${r.status}`);
      // F200 HW-4 根因②b: stable machine line so deriveSearchEvidence can
      // pair a path-based shell/Read consumption back to this candidate.
      if (r.sourcePath) lines.push(`  sourcePath: ${r.sourcePath}`);
      if (r.authority) {
        lines.push(`  authority: ${r.authority}`);
      }
      if (r.retrievalScore != null) {
        lines.push(`  retrievalScore: ${r.retrievalScore}`);
      }
      if (r.boostSource && r.boostSource.length > 0 && !r.boostSource.every((s) => s === 'legacy')) {
        lines.push(`  boost: ${r.boostSource.join(', ')}`);
      }
      if (r.matchReason) {
        lines.push(`  match: ${r.matchReason}`);
      }
      if (r.entityMatches && r.entityMatches.length > 0) {
        for (const entityMatch of r.entityMatches) {
          lines.push(...formatEntityMatchLines(entityMatch));
        }
      }
      if (r.drillDown) {
        lines.push(...formatDrillDownLines(r.drillDown));
      }
      if (r.suggestedAction) {
        lines.push(...formatSuggestedCrossPostActionLines(r.suggestedAction, { indent: '  ', detailIndent: '    ' }));
      }
      if (r.rankingFactors) {
        const factors = Object.entries(r.rankingFactors)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(3) : v}`)
          .join(', ');
        if (factors) lines.push(`  ranking: ${factors}`);
      }
      const snippet = r.snippet.length > 200 ? `${r.snippet.slice(0, 200)}...` : r.snippet;
      lines.push(`  > ${snippet.replace(/\n/g, ' ')}`);
      // AC-I9: show passage-level detail when depth=raw
      if (r.passages && r.passages.length > 0) {
        lines.push('  passages:');
        for (const p of r.passages) {
          const speaker = p.speaker ?? '?';
          const ts = p.createdAt ? ` (${p.createdAt})` : '';
          const text = p.content.length > 150 ? `${p.content.slice(0, 150)}...` : p.content;
          lines.push(`    [${p.passageId}] ${speaker}${ts}: ${text.replace(/\n/g, ' ')}`);
          if (p.context && p.context.length > 0) {
            for (const c of p.context) {
              const cs = c.speaker ?? '?';
              const ct = c.createdAt ? ` (${c.createdAt})` : '';
              const cx = c.content.length > 120 ? `${c.content.slice(0, 120)}...` : c.content;
              lines.push(`      ~ ${cs}${ct}: ${cx.replace(/\n/g, ' ')}`);
            }
          }
        }
      }
      lines.push('');
    }

    const docHits = data.results.filter(
      (r) => (r.matchRank === 'high' || r.matchRank === 'mid') && DOC_SOURCE_TYPES.has(r.sourceType),
    );

    // F188 Phase F AC-F3 + KD-7: deterministic nudge on low-hit (no high/mid doc anchors)
    const nudgeText = composeMemoryNavigationNudge(data);

    // Hook F-1: Read reminder for high/mid match-rank doc anchors (F177 Phase F)
    if (docHits.length > 0) {
      lines.push(`📌 高匹配文档命中 ${docHits.length} 个：`);
      for (const d of docHits) {
        lines.push(`   - ${d.anchor}`);
      }
      lines.push('   建议：直接 Read，不要止步摘要。摘要是索引，不是答案。');
      lines.push('');
    }

    // F256 Phase B: expansion hints — "Related directions" block
    if (data.expansionHints && data.expansionHints.length > 0) {
      lines.push('📎 Related directions:');
      for (const hint of data.expansionHints) {
        const source = hint.provenance?.source ?? '';
        const via = hint.provenance?.via ?? '';
        // AC-B2: provenance visible — show source type + via trace (砚砚 review P2)
        const strength = hint.provenance?.edgeStrength;
        const prov =
          source && via
            ? ` [${source}: ${via}]${strength ? ` [edgeStrength:${strength}]` : ''}`
            : via
              ? ` (${via})`
              : '';
        lines.push(`   - ${hint.anchor}: ${hint.title}${prov}`);
      }
      lines.push('');
    }
    if (nudgeText) {
      lines.push(nudgeText);
      lines.push('');
    }

    const coverageNudge = composeCoverageIntentNudge(input.query);
    if (coverageNudge) {
      lines.push(coverageNudge);
      lines.push('');
    }

    lines.push(depthLine);
    lines.push(
      formatRecallMeta({
        resultStatus: 'counted',
        resultCount: data.results.length,
        degraded: data.degraded,
        ...(data.degradeReason ? { degradeReason: data.degradeReason } : {}),
        previewItems: data.results.slice(0, 3).map(toRecallPreviewItem),
        readNextHint:
          docHits.length > 0
            ? `Read high/mid match-rank doc anchors directly: ${docHits.map((d) => d.anchor).join(', ')}`
            : 'Low match-rank search result; consider graph_resolve/list_recent or a narrower query.',
      }),
    );

    return successResult(lines.join('\n'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    console.error(
      `[cat-cafe-search-evidence] fetch threw for ${url}\n  query=${queryLabel}\n  err=${message}\n  cause=${JSON.stringify(cause)}\n  stack=${stack?.split('\n').slice(0, 5).join('\n')}`,
    );
    if (input.intent === 'coverage' && requestSignal?.aborted) {
      return recallErrorResult(
        `Coverage search request was cancelled or aborted before results were returned for ${queryLabel}: ${message}`,
        'Retry with a narrower scope (docs or threads) or inspect coverage stage telemetry for the stalled stage.',
      );
    }
    return recallErrorResult(
      `Evidence search request failed for ${queryLabel}: ${message}`,
      'Evidence search request failed before results were returned. Check API connectivity and retry.',
    );
  }
}

function recallErrorResult(message: string, readNextHint: string): ToolResult {
  return errorResult(
    [
      message,
      formatRecallMeta({
        resultStatus: 'error',
        resultCount: null,
        readNextHint,
      }),
    ].join('\n'),
  );
}

function toRecallPreviewItem(result: {
  title: string;
  anchor: string;
  snippet: string;
  matchRank: RecallMatchRank;
  authority?: string;
  updatedAt?: string;
}): RecallPreviewItem {
  return {
    title: result.title,
    anchor: result.anchor,
    matchRank: result.matchRank,
    ...(result.authority ? { authority: result.authority } : {}),
    ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}),
    snippet: result.snippet.length > 160 ? `${result.snippet.slice(0, 160)}...` : result.snippet,
  };
}

/**
 * F188 Phase F AC-F3 (KD-7): deterministic nudge to alternate memory entries.
 * Triggered on:
 *   - no_results (results length 0)
 *   - low match-rank hits (no high/mid doc anchors among results)
 *
 * Replaces PostToolUse hook (KD-7 v1 strategy). FM-5 measures effectiveness:
 * if猫 ignores nudge AND falls back to Bash grep, nudge has failed.
 */
function composeMemoryNavigationNudge(data: {
  results: Array<{ matchRank: string; sourceType: string }>;
}): string | null {
  if (data.results.length === 0) {
    return [
      '🧭 Memory navigation — no match, try a different entry:',
      '  • 精确 anchor (F186 / ADR-019 等) → cat_cafe_graph_resolve',
      '  • 零先验 / 扫一眼最近活动 → cat_cafe_list_recent(scope="all", since="7d")',
      '  • 换切面/多刀搜 → 加载 memory-search-best-practices skill（8 种题型 recipe + 何时停）',
    ].join('\n');
  }
  const hasHighOrMidDocHit = data.results.some(
    (r) => (r.matchRank === 'high' || r.matchRank === 'mid') && DOC_SOURCE_TYPES.has(r.sourceType),
  );
  if (!hasHighOrMidDocHit) {
    return [
      '🧭 Memory navigation — low match-rank hits, consider an alternate entry:',
      '  • 看 anchor 周边关系 → cat_cafe_graph_resolve',
      '  • 时间窗口扫描 → cat_cafe_list_recent',
      '  • 换切面/多刀搜 → 加载 memory-search-best-practices skill（题型 recipe + 补刀策略）',
    ].join('\n');
  }
  return null;
}

function formatDegradedBanner(
  degraded: boolean,
  degradeReason?: string,
  effectiveMode?: 'lexical' | 'semantic' | 'hybrid',
): string | null {
  if (!degraded) return null;
  // Kept for legacy/web contract compatibility; F209 Phase A no longer emits this reason in production.
  if (degradeReason === 'raw_lexical_only') {
    const modeNote = effectiveMode ? ` (effectiveMode=${effectiveMode})` : '';
    return `[DEGRADED] depth=raw currently uses lexical retrieval only${modeNote}`;
  }
  if (degradeReason === 'passage_embedding_unavailable') {
    const modeNote = effectiveMode ? ` (effectiveMode=${effectiveMode})` : '';
    return `[DEGRADED] raw passage embeddings unavailable; fell back to lexical retrieval${modeNote}`;
  }
  if (degradeReason === 'passage_vector_search_error') {
    const modeNote = effectiveMode ? ` (effectiveMode=${effectiveMode})` : '';
    return `[DEGRADED] raw passage vector search failed; fell back to lexical retrieval${modeNote}`;
  }
  return '[DEGRADED] Evidence store error — results may be incomplete';
}

function formatThreadFilterExecution(
  execution:
    | {
        requestedThreadId: string;
        executedThreadId: string;
        outcome: 'matched' | 'authoritative_empty' | 'degraded_empty';
      }
    | undefined,
): string | null {
  if (!execution) return null;
  const outcome =
    execution.outcome === 'authoritative_empty'
      ? 'authoritative empty'
      : execution.outcome === 'degraded_empty'
        ? 'degraded empty'
        : 'matched';
  return `🔒 Thread filter executed: ${execution.executedThreadId} (${outcome})`;
}

function formatEntityMatchLines(match: EvidenceEntityMatch): string[] {
  const details = [
    match.type ? `type=${match.type}` : null,
    match.canonicalName ? `canonicalName=${match.canonicalName}` : null,
    match.matchedAlias ? `matchedAlias=${match.matchedAlias}` : null,
    match.surface ? `surface=${match.surface}` : null,
    match.source ? `source=${match.source}` : null,
    match.docAnchor ? `docAnchor=${match.docAnchor}` : null,
    match.passageId ? `passageId=${match.passageId}` : null,
  ].filter(Boolean);
  const lines = [`  entity: ${match.entityId}${details.length > 0 ? ` (${details.join(', ')})` : ''}`];

  if (match.why) {
    lines.push(`    why: ${match.why}`);
  }

  const provenance = (match.provenance ?? [])
    .map((p) => [p.source, p.anchor, p.note, p.date].filter(Boolean).join(' / '))
    .filter(Boolean);
  if (provenance.length > 0) {
    lines.push(`    provenance: ${provenance.join('; ')}`);
  }

  return lines;
}

function formatDrillDownLines(drillDown: EvidenceDrillDown): string[] {
  const params = Object.entries(drillDown.params ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  const lines = [`  drillDown: ${drillDown.tool}${params ? ` (${params})` : ''}`];
  if (drillDown.hint) {
    lines.push(`    hint: ${drillDown.hint}`);
  }
  return lines;
}

export const evidenceTools = [
  {
    name: 'cat_cafe_search_evidence',
    description:
      'Search project knowledge base — features, decisions, architecture maps, plans, lessons, session history. ' +
      'Use when: semantically finding project knowledge, tracing a topic across docs or threads, or building a bounded coverage/source map. ' +
      'NOT for: resolving a known exact anchor (use cat_cafe_graph_resolve), scanning recent items without a query (use cat_cafe_list_recent), or reading raw messages from a known thread (use get_thread_context). ' +
      'Output: ranked evidence summaries with typed match, authority, freshness, provenance, degradation, and continuation metadata; this is read-only. ' +
      'GOTCHA: matchRank is rank position, not trust; authority is document reliability, and broad coverage requires separate docs + threads searches instead of treating one all-scope query as exhaustive. ' +
      'Semantic/fuzzy find entry point for memory recall. For precise anchors (F186, ADR-019), prefer cat_cafe_graph_resolve; for zero-prior scanning, prefer cat_cafe_list_recent; when unsure, start here with mode=hybrid. ' +
      'Supports scope (docs/threads/all), mode (lexical/semantic/hybrid), and depth (summary/raw). ' +
      'QUERY CONTRACT: query has max 2,000 characters; overlong input fails validation instead of being truncated. ' +
      'THREAD FILTER CONTRACT: threadId is enforced at the final response boundary; results can only come from that thread, and empty responses state whether the filter was authoritative or degraded. Related-direction expansion is suppressed for exact thread searches. ' +
      'COVERAGE CONTRACT: caller scope is executed exactly; coverage limit has max 20; latency is bounded; serialized output has a declared budget with explicit truncation and a continuation drill pointer. ' +
      'At the 15s API deadline coverage returns an explicit partial/degraded result; the MCP HTTP caller cancels any request that outlives that boundary plus transport grace. ' +
      'SCOPE STRATEGY (decide first!): ' +
      'docs = 结论/真相源 (features, ADRs, architecture maps, plans, lessons). ' +
      'threads = 讨论过程 (who said what, original context). ' +
      "all = broad scan only — docs dominate due to higher BM25 density, so don't rely on all for finding threads. " +
      'Rule of thumb: "要结论 → docs, 要过程 → threads, 要全貌 → both separately". ' +
      'MODE SELECTION: lexical (default) = BM25 keyword match, best for Feature IDs / exact terms (F042, Redis). ' +
      'hybrid = BM25 + vector NN + RRF fusion, RECOMMENDED for most searches — finds both exact AND semantic matches. ' +
      'semantic = pure vector nearest-neighbor, best for cross-language (English query → Chinese docs) or synonym matching. ' +
      'TIP: When unsure, use mode=hybrid. For broad surveys, add one semantic query as blind-spot insurance (hybrid misses cross-language synonyms). ' +
      'QUERY TIPS: Feature IDs (F102, F163) are strong anchors — use them when available. ' +
      'Mix Chinese + English keywords for better recall (记忆 + memory). ' +
      'Split broad topics into 2-3 targeted queries from different angles (e.g. "how it was built" vs "how it is governed"). ' +
      'Watch for antonym gaps: searching 记忆 misses 失忆/压缩/丢失 — search the opposite angle separately if needed. ' +
      'SEARCH TIPS — coverage/source-map tasks: this is not an exhaustive all-mentions entrypoint. If the user asks "哪些 / 所有 / 历史上 / 提过 / 沉淀", follow the memory-search-best-practices skill: expand terms yourself, search docs + threads separately, then drill into canonical docs/source threads and report coverage gaps. ' +
      'READING RESULTS: matchRank = rank-based match position, retrievalScore = store score when available, authority = document reliability, updated = source freshness. These are independent axes. ' +
      'RANKING (F200 live): Results are consumption-weighted — docs that cats actually read/used after searching rank higher. Constitutional docs (ADR/lesson/canon) never get demoted. New docs have 14-day grace period. Near-duplicates are MMR-deduplicated for diversity. No action needed — ranking is automatic. ' +
      'DEPTH: Start with summary (default). Use depth=raw only after narrowing scope to drill into specific passages. ' +
      'BOUNDARY: Use this tool to FIND information across the project. For READING raw messages in a specific thread, use get_thread_context instead. ' +
      'F188 PHASE F 7-TOOL FAMILY (cross-reference, choose by scenario): ' +
      'precise anchor + relations → cat_cafe_graph_resolve; ' +
      'zero-prior / scan recent → cat_cafe_list_recent; ' +
      'this tool (search_evidence) = semantic/fuzzy find; ' +
      'session drill-down → list_session_chain / read_session_digest / read_session_events / read_invocation_detail. ' +
      'When this tool returns no results or only low match-rank hits, payload appends a deterministic nudge pointing to graph_resolve/list_recent (KD-7).',
    inputSchema: searchEvidenceInputSchema,
    handler: handleSearchEvidence,
  },
] as const;
