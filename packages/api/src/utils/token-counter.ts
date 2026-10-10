/**
 * Token Counter — exact ordinary-text o200k_base context budget estimation
 *
 * Uses o200k_base (the existing gpt-4o encoding) as universal estimator.
 * ~85-90% accurate for Claude/Gemini, exact for GPT.
 * Actual token counts come from CLI usage data (see F8 Phase 2).
 */

import { countOrdinaryTokens } from './ordinary-token-counter.js';

// js-tiktoken's encode() defaults to disallowedSpecial='all', which throws on
// any GPT control-token literal (e.g. <|endoftext|>) embedded in user text.
// For budget estimation, interpret all input as ordinary text, equivalent to
// encode(text, [], []), never control tokens. See issues #591/#606.

/**
 * Estimate token count for a text string.
 * Returns 0 for empty/falsy input.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return countOrdinaryTokens(text);
}

interface MessageLike {
  content?: string;
  contentBlocks?: ReadonlyArray<{ type: string; text?: string }>;
}

/**
 * Estimate total tokens across messages, respecting per-message content truncation.
 * Only counts text content (skips images and other non-text blocks).
 */
export function estimateTokensFromMessages(messages: MessageLike[], maxContentLength: number): number {
  let total = 0;

  for (const msg of messages) {
    // Primary content field
    if (msg.content) {
      const truncated = msg.content.length > maxContentLength ? msg.content.slice(0, maxContentLength) : msg.content;
      total += estimateTokens(truncated);
    }

    // ContentBlocks — text only
    if (msg.contentBlocks) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'text' && block.text) {
          const truncated = block.text.length > maxContentLength ? block.text.slice(0, maxContentLength) : block.text;
          total += estimateTokens(truncated);
        }
      }
    }
  }

  return total;
}
