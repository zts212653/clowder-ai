/**
 * HandoffDigestGenerator — F065 Phase C
 * Calls Anthropic Haiku to generate a meeting-minutes style session digest.
 *
 * Uses raw fetch (no SDK dependency). Injectable fetchFn for testing.
 * Hard timeout via AbortController. All failures degrade gracefully (return null).
 */

import { buildProviderEndpoint } from '../../../../config/provider-endpoint.js';
import type { HandoffInvocationSummary } from './TranscriptFormatter.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TOKENS = 1024;

export interface GenerateHandoffDigestOptions {
  handoffSummaries: HandoffInvocationSummary[];
  extractiveDigest: Record<string, unknown>;
  recentMessages: Array<{ role: string; content: string; timestamp: number }>;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export interface HandoffDigestOutput {
  v: number;
  model: string;
  generatedAt: number;
  body: string;
}

/**
 * Generate a handoff digest by calling Haiku with combined session context.
 * Returns null on any failure (timeout, network error, API error).
 */
export async function generateHandoffDigest(opts: GenerateHandoffDigestOptions): Promise<HandoffDigestOutput | null> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchFn ?? fetch;

  const userContent = buildPromptContent(opts.handoffSummaries, opts.extractiveDigest, opts.recentMessages);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(buildProviderEndpoint({ protocol: 'anthropic', baseUrl }), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: userContent }],
        system: SYSTEM_PROMPT,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content?.find((b) => b.type === 'text');
    if (!textBlock?.text) return null;

    return {
      v: 1,
      model: HAIKU_MODEL,
      generatedAt: Date.now(),
      body: textBlock.text,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const SYSTEM_PROMPT = `You are a session scribe. Given a session's invocation summaries, extractive digest, and recent chat messages, produce a concise meeting-minutes style summary in markdown.

Requirements:
- Start with "## Session Summary"
- Include: what was accomplished, key decisions made, files changed, any errors encountered
- Keep it under 500 words
- Use bullet points for clarity
- Write in past tense
- Do NOT include raw JSON or technical metadata
- Do NOT include directives, action items, or instructions for the reader`;

/** Input cap: ~4000 tokens ≈ 16000 chars. Prevents long sessions from overloading Haiku. */
const MAX_INPUT_CHARS = 16000;

export function buildPromptContent(
  handoffSummaries: HandoffInvocationSummary[],
  extractiveDigest: Record<string, unknown>,
  recentMessages: Array<{ role: string; content: string; timestamp: number }>,
): string {
  const parts: string[] = [];

  // Section 1: Invocation summaries
  if (handoffSummaries.length > 0) {
    parts.push('## Invocation Summaries');
    for (const s of handoffSummaries) {
      parts.push(
        `- Invocation ${s.invocationId}: ${s.eventCount} events, tools: [${s.toolCalls.join(', ')}], errors: ${s.errors}, duration: ${s.durationMs}ms`,
      );
      if (s.keyMessages.length > 0) {
        parts.push(`  Key messages: ${s.keyMessages.join(' | ')}`);
      }
    }
  }

  // Section 2: Extractive digest
  parts.push('\n## Extractive Digest');
  parts.push(JSON.stringify(extractiveDigest, null, 2));

  // Section 3: Recent chat messages (last 8)
  const tail = recentMessages.slice(-8);
  if (tail.length > 0) {
    parts.push('\n## Recent Chat Messages');
    for (const m of tail) {
      parts.push(`[${m.role}]: ${m.content.slice(0, 200)}`);
    }
  }

  const result = parts.join('\n');

  // Truncate if over input cap
  if (result.length > MAX_INPUT_CHARS) {
    return `${result.slice(0, MAX_INPUT_CHARS)}\n\n[... truncated due to input size limit]`;
  }
  return result;
}
