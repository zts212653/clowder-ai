/**
 * F22: Rich Block Text Extraction (Route B fallback)
 *
 * Extracts ```cc_rich {...}``` blocks from cat response text,
 * parses them as RichBlock arrays, and returns clean text + blocks.
 * Used for cats without MCP (Codex, Gemini) that embed rich blocks in text.
 */

import type { RichBlock } from '@cat-cafe/shared';
import { isValidRichBlock, normalizeRichBlock } from '@cat-cafe/shared';

// Re-export for backward compat (tests import from here)
export { isValidRichBlock, normalizeRichBlock };

const CC_RICH_RE = /```cc_rich\s*\n([\s\S]*?)\n```/g;

/**
 * #85 M3: Check if an object looks like a rich block candidate (has id + kind/type).
 * Used for strong-match bare JSON detection — lightweight, no full validation.
 */
export function isRichBlockCandidate(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  return typeof obj.id === 'string' && ('kind' in obj || 'type' in obj);
}

export function extractRichFromText(text: string): {
  cleanText: string;
  blocks: RichBlock[];
} {
  const blocks: RichBlock[] = [];
  const cleanText = text
    .replace(CC_RICH_RE, (_match, json: string) => {
      try {
        const parsed = JSON.parse(json);
        if (parsed?.v === 1 && Array.isArray(parsed.blocks)) {
          for (const b of parsed.blocks) {
            const normalized = normalizeRichBlock(b);
            if (isValidRichBlock(normalized)) {
              blocks.push(normalized);
            }
          }
        }
      } catch {
        /* Parse failure → ignore, keep as plain text */
      }
      return '';
    })
    .trimEnd();

  // #85 M3: Bare JSON array strong-match fallback.
  // If no cc_rich blocks found, check if the entire message is a bare JSON array
  // where every element looks like a rich block candidate (has id + kind/type).
  if (blocks.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr) && arr.length > 0 && arr.every(isRichBlockCandidate)) {
          const validated: RichBlock[] = [];
          for (const b of arr) {
            const normalized = normalizeRichBlock(b);
            if (isValidRichBlock(normalized)) validated.push(normalized);
          }
          // Only accept if ALL elements validated — partial match means this
          // is not a pure rich-block array; keep original text intact (#85 P1).
          if (validated.length === arr.length) return { cleanText: '', blocks: validated };
        }
      } catch {
        /* not valid JSON, ignore */
      }
    }
  }

  return { cleanText, blocks };
}
