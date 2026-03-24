/**
 * Reflect Tool
 * MCP 工具: 项目知识反思 (SQLite-backed)
 *
 * F102: 猫猫可通过 MCP 调用 /reflect 获取项目知识反思。
 */

import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

export const reflectInputSchema = {
  query: z.string().trim().min(1).describe('Question to reflect on using project knowledge'),
};

export async function handleReflect(input: { query: string }): Promise<ToolResult> {
  const url = `${API_URL}/api/reflect`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: input.query }),
    });

    if (!response.ok) {
      const text = await response.text();
      return errorResult(`Reflect failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      reflection: string;
      degraded: boolean;
      degradeReason?: string;
    };

    if (data.degraded) {
      return successResult(
        `[DEGRADED] Reflection service unavailable (${data.degradeReason ?? 'unknown'}). Use search_evidence instead.`,
      );
    }

    return successResult(data.reflection);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Reflect request failed: ${message}`);
  }
}

export const reflectTools = [
  {
    name: 'cat_cafe_reflect',
    description:
      'Ask a reflective question about the project. Synthesizes insights from stored project knowledge (SQLite-backed). ' +
      'Use for open-ended "why" questions that benefit from synthesis across multiple sources. ' +
      'GOTCHA: Currently degraded — use search_evidence instead. This tool is kept for future synthesis capability. ' +
      'WHEN TO USE: search_evidence finds facts; reflect synthesizes meaning. If search_evidence already answered your question, skip this.',
    inputSchema: reflectInputSchema,
    handler: handleReflect,
  },
] as const;
