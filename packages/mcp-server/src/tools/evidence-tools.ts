/**
 * Evidence Search Tool
 * MCP 工具: 搜索项目知识 (Hindsight Recall + docs fallback)
 *
 * 不依赖 callback 鉴权 — evidence 路由是公开 GET。
 */

import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3003';

export const searchEvidenceInputSchema = {
  query: z.string().min(1).describe('Search query for project knowledge'),
  limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
  budget: z.enum(['low', 'mid', 'high']).optional().describe('Search budget (default mid)'),
  tags: z.string().optional().describe('Comma-separated tags to filter (default: project:cat-cafe)'),
};

export async function handleSearchEvidence(input: {
  query: string;
  limit?: number | undefined;
  budget?: string | undefined;
  tags?: string | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams({ q: input.query });
  if (input.limit != null) params.set('limit', String(input.limit));
  if (input.budget) params.set('budget', input.budget);
  if (input.tags) {
    const tags = input.tags
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    for (const tag of tags) {
      params.append('tags', tag);
    }
  }

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
      lines.push('[DEGRADED] Results from local docs fallback (Hindsight unavailable)');
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
      'Search project knowledge base for decisions, discussions, phase history, and other evidence. Uses Hindsight Recall with local docs fallback.',
    inputSchema: searchEvidenceInputSchema,
    handler: handleSearchEvidence,
  },
] as const;
