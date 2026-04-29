/**
 * Token Counter — js-tiktoken wrapper for context budget estimation
 *
 * Uses cl100k_base (GPT-4 family) as universal estimator.
 * ~85-90% accurate for Claude/Gemini, exact for GPT.
 * Actual token counts come from CLI usage data (see F8 Phase 2).
 */

import { encodingForModel } from 'js-tiktoken';

/** Lazily initialized singleton encoder */
let encoder: ReturnType<typeof encodingForModel> | null = null;

function getEncoder() {
  if (!encoder) {
    encoder = encodingForModel('gpt-4o');
  }
  return encoder;
}

// js-tiktoken's encode() defaults to disallowedSpecial='all', which throws on
// any GPT control-token literal (e.g. <|endoftext|>) embedded in user text.
// Passing allowedSpecial='all' avoids the throw but undercounts those literals
// as control tokens. For budget estimation, allow no special tokens and disallow
// no special tokens so all input is encoded as ordinary text. See issues #591/#606.
const NO_SPECIAL_TOKENS: string[] = [];

/**
 * Estimate token count for a text string.
 * Returns 0 for empty/falsy input.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text, NO_SPECIAL_TOKENS, NO_SPECIAL_TOKENS).length;
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
  const enc = getEncoder();
  let total = 0;

  for (const msg of messages) {
    // Primary content field
    if (msg.content) {
      const truncated = msg.content.length > maxContentLength ? msg.content.slice(0, maxContentLength) : msg.content;
      total += enc.encode(truncated, NO_SPECIAL_TOKENS, NO_SPECIAL_TOKENS).length;
    }

    // ContentBlocks — text only
    if (msg.contentBlocks) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'text' && block.text) {
          const truncated = block.text.length > maxContentLength ? block.text.slice(0, maxContentLength) : block.text;
          total += enc.encode(truncated, NO_SPECIAL_TOKENS, NO_SPECIAL_TOKENS).length;
        }
      }
    }
  }

  return total;
}
