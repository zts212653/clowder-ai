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
};

export async function handleSearchEvidence(input: {
  query: string;
  limit?: number | undefined;
  scope?: string | undefined;
  mode?: string | undefined;
  depth?: string | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams({ q: input.query });
  if (input.limit != null) params.set('limit', String(input.limit));
  if (input.scope) params.set('scope', input.scope);
  if (input.mode) params.set('mode', input.mode);
  if (input.depth) params.set('depth', input.depth);

  const url = `${API_URL}/api/evidence/search?${params.toString()}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      return errorResult(`Evidence search failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      results: Array<{
        title: string;
        anchor: string;
        snippet: string;
        confidence: string;
        sourceType: string;
      }>;
      degraded: boolean;
      degradeReason?: string;
    };

    if (data.results.length === 0) {
      const prefix = data.degraded ? '[DEGRADED] ' : '';
      return successResult(`${prefix}No results found for: ${input.query}`);
    }

    const lines: string[] = [];
    if (data.degraded) {
      lines.push('[DEGRADED] Evidence store error — results may be incomplete');
      lines.push('');
    }

    lines.push(`Found ${data.results.length} result(s):`);
    lines.push('');

    for (const r of data.results) {
      lines.push(`[${r.confidence}] ${r.title}`);
      lines.push(`  anchor: ${r.anchor}`);
      lines.push(`  type: ${r.sourceType}`);
      const snippet = r.snippet.length > 200 ? `${r.snippet.slice(0, 200)}...` : r.snippet;
      lines.push(`  > ${snippet.replace(/\n/g, ' ')}`);
      lines.push('');
    }

    return successResult(lines.join('\n'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Evidence search request failed: ${message}`);
  }
}

export const evidenceTools = [
  {
    name: 'cat_cafe_search_evidence',
    description:
      'Search project knowledge base — features, decisions, plans, lessons, session history. ' +
      'This is the PRIMARY entry point for all memory recall. Start here before drilling down. ' +
      'Supports scope (docs/threads/all), mode (lexical/semantic/hybrid), and depth (summary/raw). ' +
      'MODE SELECTION: lexical (default) = BM25 keyword match, best for Feature IDs / exact terms (F042, Redis). ' +
      'hybrid = BM25 + vector NN + RRF fusion, RECOMMENDED for most searches — finds both exact AND semantic matches. ' +
      'semantic = pure vector nearest-neighbor, best for cross-language (English query → Chinese docs) or synonym matching. ' +
      'TIP: When unsure, use mode=hybrid.',
    inputSchema: searchEvidenceInputSchema,
    handler: handleSearchEvidence,
  },
] as const;
