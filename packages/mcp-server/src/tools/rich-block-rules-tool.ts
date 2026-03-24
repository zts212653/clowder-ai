/**
 * Rich Block Rules Tool
 * MCP 工具: 按需获取富消息块完整使用规范
 *
 * F-BLOAT: 渐进式披露——系统提示词只含短引用，
 * 猫猫首次使用富块前调用此工具获取完整规则。
 */

import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

export async function handleGetRichBlockRules(): Promise<ToolResult> {
  const url = `${API_URL}/api/callbacks/rich-block-rules`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      return errorResult(`Failed to fetch rich block rules (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { rules: string };
    return successResult(data.rules);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Rich block rules request failed: ${message}`);
  }
}

export const richBlockRulesInputSchema = {};

export const richBlockRulesTools = [
  {
    name: 'cat_cafe_get_rich_block_rules',
    description:
      'Get the full rich block usage rules (card/diff/checklist/media_gallery/audio/interactive). ' +
      'Call this BEFORE creating your first rich block in a session — it returns the full schema and constraints. ' +
      'You only need to call this once per session; the rules do not change within a session. ' +
      'GOTCHA: Without loading these rules first, you will likely produce invalid block JSON (wrong field names, missing required fields).',
    inputSchema: richBlockRulesInputSchema,
    handler: handleGetRichBlockRules,
  },
] as const;
