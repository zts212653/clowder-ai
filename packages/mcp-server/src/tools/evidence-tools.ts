/**
 * Evidence Search Tool
 * MCP 工具: 搜索项目知识 (SQLite FTS5 + semantic rerank)
 *
 * F102 Phase D: 统一检索入口。支持 scope/mode/depth 分层。
 * 不依赖 callback 鉴权 — evidence 路由是公开 GET。
 */

import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

const DOC_SOURCE_TYPES = new Set(['feature', 'decision', 'phase', 'lesson', 'plan', 'research']);
const EVIDENCE_RESULT_MARKER = 'Evidence search results:';
let searchCount = 0;

export const searchEvidenceInputSchema = {
  query: z.string().min(1).describe('Search query for project knowledge'),
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
};

export async function handleSearchEvidence(input: {
  query: string;
  limit?: number | undefined;
  scope?: string | undefined;
  mode?: string | undefined;
  depth?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  contextWindow?: number | undefined;
  threadId?: string | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams({ q: input.query });
  if (input.limit != null) params.set('limit', String(input.limit));
  if (input.scope) params.set('scope', input.scope);
  if (input.mode) params.set('mode', input.mode);
  if (input.depth) params.set('depth', input.depth);
  if (input.dateFrom) params.set('dateFrom', input.dateFrom);
  if (input.dateTo) params.set('dateTo', input.dateTo);
  if (input.contextWindow != null) params.set('contextWindow', String(input.contextWindow));
  if (input.threadId) params.set('threadId', input.threadId);

  const url = `${API_URL}/api/evidence/search?${params.toString()}`;
  const queryLabel = JSON.stringify(input.query);

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      return errorResult(`Evidence search failed for ${queryLabel} (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      results: Array<{
        title: string;
        anchor: string;
        snippet: string;
        confidence: string;
        sourceType: string;
        authority?: string;
        boostSource?: string[];
        passages?: Array<{
          passageId: string;
          content: string;
          speaker?: string;
          createdAt?: string;
          context?: Array<{
            passageId: string;
            content: string;
            speaker?: string;
            createdAt?: string;
          }>;
        }>;
      }>;
      degraded: boolean;
      degradeReason?: string;
      effectiveMode?: 'lexical' | 'semantic' | 'hybrid';
      variantId?: string;
    };

    const degradedBanner = formatDegradedBanner(data.degraded, data.degradeReason, data.effectiveMode);

    // Hook F-3: search depth tracking runs on ALL searches including empty results
    searchCount++;
    const depthLine = `📊 本轮第 ${searchCount} 次搜索 | 搜到 doc anchor → Read 源文件，不要用摘要推理`;
    const docHitsForTelemetry = data.results.filter(
      (r) => (r.confidence === 'high' || r.confidence === 'mid') && DOC_SOURCE_TYPES.has(r.sourceType),
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
      const parts = [degradedBanner, noResultMsg, depthLine].filter(Boolean);
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

    for (const r of data.results) {
      lines.push(`[${r.confidence}] ${r.title}`);
      lines.push(`  anchor: ${r.anchor}`);
      lines.push(`  type: ${r.sourceType}`);
      if (r.authority) {
        lines.push(`  authority: ${r.authority}`);
      }
      if (r.boostSource && r.boostSource.length > 0 && !r.boostSource.every((s) => s === 'legacy')) {
        lines.push(`  boost: ${r.boostSource.join(', ')}`);
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

    // Hook F-1: Read reminder for high/mid confidence doc anchors (F177 Phase F)
    const docHits = data.results.filter(
      (r) => (r.confidence === 'high' || r.confidence === 'mid') && DOC_SOURCE_TYPES.has(r.sourceType),
    );
    if (docHits.length > 0) {
      lines.push(`📌 高置信度文档命中 ${docHits.length} 个：`);
      for (const d of docHits) {
        lines.push(`   - ${d.anchor}`);
      }
      lines.push('   建议：直接 Read，不要止步摘要。摘要是索引，不是答案。');
      lines.push('');
    }

    lines.push(depthLine);

    return successResult(lines.join('\n'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Evidence search request failed for ${queryLabel}: ${message}`);
  }
}

function formatDegradedBanner(
  degraded: boolean,
  degradeReason?: string,
  effectiveMode?: 'lexical' | 'semantic' | 'hybrid',
): string | null {
  if (!degraded) return null;
  if (degradeReason === 'raw_lexical_only') {
    const modeNote = effectiveMode ? ` (effectiveMode=${effectiveMode})` : '';
    return `[DEGRADED] depth=raw currently uses lexical retrieval only${modeNote}`;
  }
  return '[DEGRADED] Evidence store error — results may be incomplete';
}

export const evidenceTools = [
  {
    name: 'cat_cafe_search_evidence',
    description:
      'Search project knowledge base — features, decisions, plans, lessons, session history. ' +
      'This is the PRIMARY entry point for all memory recall. Start here before drilling down. ' +
      'Supports scope (docs/threads/all), mode (lexical/semantic/hybrid), and depth (summary/raw). ' +
      'SCOPE STRATEGY (decide first!): ' +
      'docs = 结论/真相源 (features, ADRs, plans, lessons). ' +
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
      'READING RESULTS: confidence = search match quality (rank-based), authority = document reliability (path-based) — two independent dimensions. ' +
      'DEPTH: Start with summary (default). Use depth=raw only after narrowing scope to drill into specific passages. ' +
      'BOUNDARY: Use this tool to FIND information across the project. For READING raw messages in a specific thread, use get_thread_context instead.',
    inputSchema: searchEvidenceInputSchema,
    handler: handleSearchEvidence,
  },
] as const;
