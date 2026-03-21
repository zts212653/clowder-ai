/**
 * Phase G: Opus API client for generating abstractive summaries + durable candidates.
 *
 * Depends on F062 provider-profiles for API access.
 * Feature-flagged: only active when F102_ABSTRACTIVE=on.
 */

import { SUMMARY_CONFIG } from './summary-config.js';

export interface AbstractiveInput {
  previousSummary: string | null;
  messages: Array<{ id: string; content: string; catId?: string; timestamp: number }>;
  threadId: string;
}

export interface TopicSegment {
  summary: string;
  topicKey: string;
  topicLabel: string;
  boundaryReason: string;
  boundaryConfidence: 'high' | 'medium' | 'low';
  fromMessageId: string;
  toMessageId: string;
  messageCount: number;
  relatedSegmentIds?: string[];
  candidates?: DurableCandidate[];
}

export interface DurableCandidate {
  kind: 'decision' | 'lesson' | 'method';
  title: string;
  claim: string;
  why_durable: string;
  evidence: Array<{ threadId: string; messageId: string; span: string }>;
  relatedAnchors: string[];
  confidence: 'explicit' | 'inferred';
}

export interface AbstractiveResult {
  segments: TopicSegment[];
}

interface ProviderProfile {
  mode: 'api_key' | 'subscription';
  baseUrl: string;
  apiKey: string;
}

const SYSTEM_PROMPT = `You are a thread summarizer for Clowder AI, an AI-collaborative project management system.

Your job: Given a batch of new messages from a thread (and optionally a previous summary), produce:
1. One or more TOPIC SEGMENTS — each is a coherent sub-discussion within the batch
2. DURABLE CANDIDATES — knowledge worth preserving long-term (decisions, lessons, methods)

## Topic Segmentation Rules (STRICT)
- Segments MUST be contiguous, non-overlapping, and completely cover the batch
- Segments MUST be ordered by message sequence
- Maximum 3 segments per batch
- If unsure about boundaries, produce 1 segment (prefer merging over splitting)
- Minimum batch size for splitting: 8 messages or 600 tokens
- Each segment needs: topicKey (stable slug), topicLabel (human title), boundaryReason

## Candidate Extraction Rules (STRICT — you are an EXTRACTOR not a SUMMARIZER)
- Only 3 kinds: decision, lesson, method
- MUST include evidence (threadId, messageId, original text span)
- MUST include relatedAnchors (feature/decision IDs mentioned)
- DO NOT extract: brainstorm branches, temporary TODOs, session-local context, unsupported model inferences
- "explicit" confidence: only if owner explicitly decided, clear consensus exists, or already merged to code/doc
- "inferred" confidence: everything else
- If nothing is worth extracting, return empty candidates array

## Output Format
Respond with ONLY valid JSON matching this schema:
{
  "segments": [{
    "summary": "200-400 chars, what was discussed/decided/risks/next-steps",
    "topicKey": "stable-slug",
    "topicLabel": "Human Readable Title",
    "boundaryReason": "why this segment boundary exists",
    "boundaryConfidence": "high|medium|low",
    "fromMessageId": "first msg id in this segment",
    "toMessageId": "last msg id in this segment",
    "messageCount": 20,
    "candidates": [...]
  }]
}`;

function buildUserPrompt(input: AbstractiveInput): string {
  const parts: string[] = [];

  if (input.previousSummary) {
    parts.push(`## Previous Thread Summary\n${input.previousSummary}\n`);
  }

  parts.push(`## New Messages (thread: ${input.threadId})\n`);
  for (const msg of input.messages) {
    const speaker = msg.catId ?? 'user';
    const time = new Date(msg.timestamp).toISOString().slice(0, 19);
    parts.push(`[${time}] [${speaker}] (${msg.id}): ${msg.content}`);
  }

  return parts.join('\n');
}

/**
 * Create a generateAbstractive function that calls the Opus API.
 * Returns null on any error (fail-open).
 */
export function createAbstractiveClient(
  resolveProfile: () => Promise<ProviderProfile | null>,
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void },
): (input: AbstractiveInput) => Promise<AbstractiveResult | null> {
  return async (input: AbstractiveInput): Promise<AbstractiveResult | null> => {
    const profile = await resolveProfile();
    if (!profile || profile.mode !== 'api_key') {
      logger.info('[abstractive-client] no API key profile, skipping');
      return null;
    }

    const userContent = buildUserPrompt(input);
    const config = SUMMARY_CONFIG;

    try {
      const res = await fetch(`${profile.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': profile.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }],
        }),
      });

      if (!res.ok) {
        logger.error(`[abstractive-client] API error ${res.status}: ${res.statusText}`);
        return null;
      }

      const body = (await res.json()) as { content: Array<{ type: string; text?: string }> };
      const text = body.content?.find((c) => c.type === 'text')?.text;
      if (!text) {
        logger.error('[abstractive-client] no text in response');
        return null;
      }

      const parsed = JSON.parse(text) as AbstractiveResult;

      // P2 fix (砚砚 review): validate structural constraints, not just presence
      const validated = validateSegments(parsed, input.messages, config, logger);
      return validated;
    } catch (err) {
      logger.error('[abstractive-client] fetch/parse error', err);
      return null;
    }
  };
}

/**
 * P2 fix (砚砚 review): validate structural constraints on model output.
 * External model output cannot be trusted on prompt alone.
 *
 * KD-43 constraints: contiguous, non-overlapping, cover batch, max 3 segments.
 */
function validateSegments(
  parsed: AbstractiveResult,
  messages: Array<{ id: string }>,
  config: typeof SUMMARY_CONFIG,
  logger: { error: (msg: string) => void },
): AbstractiveResult | null {
  if (!parsed.segments || !Array.isArray(parsed.segments) || parsed.segments.length === 0) {
    logger.error('[abstractive-client] invalid segments: empty or not array');
    return null;
  }

  // Truncate excess segments
  if (parsed.segments.length > config.maxTopicSegments) {
    parsed.segments = parsed.segments.slice(0, config.maxTopicSegments);
  }

  // Validate each segment has required fields
  for (const seg of parsed.segments) {
    if (!seg.summary || !seg.topicKey || !seg.topicLabel || !seg.fromMessageId || !seg.toMessageId) {
      logger.error('[abstractive-client] segment missing required fields, rejecting batch');
      return null;
    }
    // Ensure messageCount is positive
    if (typeof seg.messageCount !== 'number' || seg.messageCount <= 0) {
      seg.messageCount = 1; // fallback
    }
    // Normalize confidence
    if (!['high', 'medium', 'low'].includes(seg.boundaryConfidence)) {
      seg.boundaryConfidence = 'medium';
    }
  }

  // Validate contiguity: each segment's toMessageId should match next segment's fromMessageId area
  // (We check that from/to IDs exist in the input batch; strict ordering is enforced by prompt)
  const msgIdSet = new Set(messages.map((m) => m.id));
  for (const seg of parsed.segments) {
    if (!msgIdSet.has(seg.fromMessageId) || !msgIdSet.has(seg.toMessageId)) {
      logger.error(
        `[abstractive-client] segment references messageId not in batch: ${seg.fromMessageId}..${seg.toMessageId}`,
      );
      return null;
    }
  }

  // Validate ordering + contiguity + non-overlap + coverage
  const msgIdxMap = new Map(messages.map((m, i) => [m.id, i]));
  const ranges: Array<[number, number]> = [];

  for (const seg of parsed.segments) {
    const fromIdx = msgIdxMap.get(seg.fromMessageId)!;
    const toIdx = msgIdxMap.get(seg.toMessageId)!;
    if (fromIdx > toIdx) {
      logger.error(
        `[abstractive-client] segment has inverted range: ${seg.fromMessageId}(${fromIdx}) > ${seg.toMessageId}(${toIdx})`,
      );
      return null;
    }
    ranges.push([fromIdx, toIdx]);
  }

  // Check non-overlapping: each segment's fromIdx must be > previous segment's toIdx
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]![0] <= ranges[i - 1]![1]) {
      logger.error(
        `[abstractive-client] segments overlap: seg[${i - 1}] ends at ${ranges[i - 1]![1]}, seg[${i}] starts at ${ranges[i]![0]}`,
      );
      return null;
    }
  }

  // Check coverage: first segment must start at batch start, last must end at batch end
  if (ranges[0]![0] !== 0) {
    logger.error(`[abstractive-client] segments don't cover batch start: first segment starts at idx ${ranges[0]![0]}`);
    return null;
  }
  if (ranges[ranges.length - 1]![1] !== messages.length - 1) {
    logger.error(
      `[abstractive-client] segments don't cover batch end: last segment ends at idx ${ranges[ranges.length - 1]![1]}, batch has ${messages.length} messages`,
    );
    return null;
  }

  // Check contiguity: no gaps between segments (each from = prev.to + 1)
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]![0] !== ranges[i - 1]![1] + 1) {
      logger.error(
        `[abstractive-client] gap between segments: seg[${i - 1}] ends at ${ranges[i - 1]![1]}, seg[${i}] starts at ${ranges[i]![0]}`,
      );
      return null;
    }
  }

  return parsed;
}
