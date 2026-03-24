/**
 * MCP Callback Memory Tools — invocation-scoped evidence/reflect/retain
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

export const callbackRetainMemoryInputSchema = {
  content: z.string().trim().min(1).describe('Memory content to retain'),
  tags: z.array(z.string().min(1)).optional().describe('Optional memory tags'),
  metadata: z.record(z.string()).optional().describe('Optional metadata (string values only)'),
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

export async function handleCallbackRetainMemory(input: {
  content: string;
  tags?: string[] | undefined;
  metadata?: Record<string, string> | undefined;
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/retain-memory', {
    content: input.content,
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export const callbackMemoryTools = [
  // D16: search_evidence_callback and reflect_callback removed — merged into
  // the public search_evidence / reflect tools (route supports both auth modes).
  {
    name: 'cat_cafe_retain_memory_callback',
    description:
      'Retain a durable memory item through Cat Cafe callback endpoint. ' +
      'Use when you discover an important insight, decision, or lesson that should persist across sessions. ' +
      'Examples: architectural decisions made during discussion, gotchas discovered while debugging, ' +
      'cross-cat agreements. NOT for transient notes — only for knowledge worth remembering long-term. ' +
      'TIP: Add descriptive tags (e.g. ["redis", "pitfall"]) so future search_evidence queries can find it.',
    inputSchema: callbackRetainMemoryInputSchema,
    handler: handleCallbackRetainMemory,
  },
] as const;
