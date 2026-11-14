/**
 * MCP Callback Memory handlers — invocation-scoped evidence/reflect.
 *
 * No tools are registered from this file any more:
 * - D16 merged search_evidence_callback / reflect_callback into the public tools.
 * - 2026-11-09 retired the retain_memory_callback tool (memory entry subtraction;
 *   0 calls in 30 days, see docs/evidence/2026-11-09-memory-tool-usage-census/).
 */

import { z } from 'zod';
import { callbackGet, callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

export const callbackEvidenceSearchInputSchema = {
  query: z.string().trim().min(1).describe('Evidence query string'),
  limit: z.number().int().min(1).max(20).optional().describe('Maximum number of results (default: 5)'),
  budget: z.enum(['low', 'mid', 'high']).optional().describe('Recall budget profile'),
  tags: z.string().optional().describe('Comma-separated tags (example: project:cat-cafe,kind:decision)'),
  tagsMatch: z.enum(['any', 'all', 'any_strict', 'all_strict']).optional().describe('Tag matching strategy'),
};

export const callbackReflectInputSchema = {
  query: z.string().trim().min(1).describe('Reflection question'),
};

export async function handleCallbackSearchEvidence(input: {
  query: string;
  limit?: number | undefined;
  budget?: 'low' | 'mid' | 'high' | undefined;
  tags?: string | undefined;
  tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict' | undefined;
}): Promise<ToolResult> {
  return callbackGet('/api/callbacks/search-evidence', {
    q: input.query,
    ...(input.limit != null ? { limit: String(input.limit) } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.tagsMatch ? { tagsMatch: input.tagsMatch } : {}),
  });
}

export async function handleCallbackReflect(input: { query: string }): Promise<ToolResult> {
  return callbackPost('/api/callbacks/reflect', { query: input.query });
}
