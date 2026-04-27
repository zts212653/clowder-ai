// F148: Hierarchical Context Transport — pure functions for smart window assembly.

import type { HierarchicalContextConfig } from '../../../../../config/hierarchical-context-config.js';
import { getSenderName } from '../../context/ContextAssembler.js';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';

// --- Phase D: Coverage Map (AC-D2) ---

export interface CoverageMap {
  omitted: { count: number; timeRange: { from: number; to: number }; participants: string[] };
  burst: { count: number; timeRange: { from: number; to: number } };
  anchorIds: string[];
  threadMemory: {
    available: boolean;
    sessionsIncorporated: number;
    decisions?: string[];
    openQuestions?: string[];
  } | null;
  retrievalHints: string[];
  searchSuggestions?: string[];
}

export interface CoverageMapInput {
  omitted: { count: number; from: number; to: number; participants: string[] };
  burst: { count: number; from: number; to: number };
  anchorIds: string[];
  threadMemory: {
    available: boolean;
    sessionsIncorporated: number;
    decisions?: string[];
    openQuestions?: string[];
  } | null;
  retrievalHints: string[];
  searchSuggestions?: string[];
}

export function buildCoverageMap(input: CoverageMapInput): CoverageMap {
  return {
    omitted: {
      count: input.omitted.count,
      timeRange: { from: input.omitted.from, to: input.omitted.to },
      participants: input.omitted.participants,
    },
    burst: {
      count: input.burst.count,
      timeRange: { from: input.burst.from, to: input.burst.to },
    },
    anchorIds: input.anchorIds,
    threadMemory: input.threadMemory,
    retrievalHints: input.retrievalHints,
    ...(input.searchSuggestions?.length ? { searchSuggestions: input.searchSuggestions } : {}),
  };
}

/**
 * F148: Detect the most recent interaction burst from the tail of messages.
 * Walks backward from the end, stopping at a silence gap >= config threshold.
 * Guarantees at least minBurstMessages, caps at maxBurstMessages.
 * Never splits semantic chains (Q→A, tool_use→tool_result).
 */
export function detectRecentBurst(
  messages: readonly StoredMessage[],
  config: HierarchicalContextConfig,
): { burst: StoredMessage[]; omitted: StoredMessage[] } {
  const len = messages.length;
  if (len === 0) return { burst: [], omitted: [] };

  // Walk backward from the tail to find a silence gap
  let cutIndex = 0; // default: include all
  for (let i = len - 1; i > 0; i--) {
    const gap = messages[i].timestamp - messages[i - 1].timestamp;
    const tailCount = len - i;
    if (gap >= config.burstSilenceGapMs && tailCount >= config.minBurstMessages) {
      cutIndex = i;
      break;
    }
  }

  // Apply maxBurstMessages cap
  let burstStart = cutIndex;
  const burstLen = len - cutIndex;
  if (burstLen > config.maxBurstMessages) {
    burstStart = len - config.maxBurstMessages;
  }

  // Semantic chain protection: don't split at the boundary
  burstStart = protectSemanticChains(messages, burstStart);

  // Ensure minBurstMessages guarantee
  const finalBurstLen = len - burstStart;
  if (finalBurstLen < config.minBurstMessages) {
    burstStart = Math.max(0, len - config.minBurstMessages);
  }

  const burst = messages.slice(burstStart);
  const omitted = messages.slice(0, burstStart);
  return { burst: [...burst], omitted: [...omitted] };
}

/**
 * Ensure the cut point doesn't split semantic chains:
 * 1. If msg[burstStart] is a cat answer and msg[burstStart-1] is a user question → include the question
 * 2. If msg[burstStart] has tool_result and msg[burstStart-1] has matching tool_use → include the tool_use
 */
function protectSemanticChains(messages: readonly StoredMessage[], burstStart: number): number {
  if (burstStart <= 0) return burstStart;

  const firstInBurst = messages[burstStart];
  const preceding = messages[burstStart - 1];

  // Tool chain: if first-in-burst has tool_result events, check if preceding has tool_use
  if (hasToolResult(firstInBurst) && hasToolUse(preceding)) {
    return protectSemanticChains(messages, burstStart - 1);
  }

  // Q→A chain: if first-in-burst is a cat message and preceding is a user message
  if (firstInBurst.catId && !preceding.catId) {
    return protectSemanticChains(messages, burstStart - 1);
  }

  return burstStart;
}

function hasToolUse(msg: StoredMessage): boolean {
  return msg.toolEvents?.some((e) => e.type === 'tool_use') ?? false;
}

function hasToolResult(msg: StoredMessage): boolean {
  return msg.toolEvents?.some((e) => e.type === 'tool_result') ?? false;
}

// --- Tombstone ---

export interface ContextTombstone {
  omittedCount: number;
  timeRange: { from: number; to: number };
  participants: string[];
  keywords: string[];
  retrievalHints: string[];
}

// Common English stopwords + short words to skip in keyword extraction
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'need',
  'must',
  'and',
  'but',
  'or',
  'not',
  'no',
  'nor',
  'so',
  'yet',
  'for',
  'in',
  'on',
  'at',
  'to',
  'of',
  'by',
  'from',
  'with',
  'as',
  'into',
  'about',
  'up',
  'out',
  'off',
  'over',
  'under',
  'then',
  'than',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'i',
  'me',
  'my',
  'we',
  'us',
  'our',
  'you',
  'your',
  'he',
  'she',
  'they',
  'them',
  'what',
  'which',
  'who',
  'whom',
  'how',
  'when',
  'where',
  'why',
  'all',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'some',
  'any',
  'just',
  'also',
  'very',
  'too',
  'only',
  'still',
  'here',
  'there',
  'if',
  'because',
  'while',
  'after',
  'before',
]);

/**
 * F148: Build a coverage tombstone for omitted messages.
 * Zero LLM cost — uses simple word frequency for keywords.
 */
export function buildTombstone(
  omitted: readonly StoredMessage[],
  threadTitle: string,
  config: HierarchicalContextConfig,
  threadId?: string,
): ContextTombstone | null {
  if (omitted.length === 0) return null;

  const participants = [...new Set(omitted.filter((m) => m.catId).map((m) => m.catId as string))];

  const timeRange = {
    from: omitted[0].timestamp,
    to: omitted[omitted.length - 1].timestamp,
  };

  // Keyword extraction: simple word frequency on content
  const wordCounts = new Map<string, number>();
  for (const msg of omitted) {
    const words = msg.content
      .toLowerCase()
      .split(/[^a-zA-Z0-9\u4e00-\u9fff]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    for (const w of words) {
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
  }

  const keywords = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.maxTombstoneKeywords)
    .map(([word]) => word);

  const keywordHint = keywords.length > 0 ? keywords.slice(0, 2).join(' ') : threadTitle;
  const baseHint = threadId
    ? `search_evidence("${keywordHint}", threadId="${threadId}")`
    : `search_evidence("${keywordHint}")`;
  const retrievalHints = [baseHint];

  return { omittedCount: omitted.length, timeRange, participants, keywords, retrievalHints };
}

/** Format tombstone as compact context string (~40 tokens) */
export function formatTombstone(tombstone: ContextTombstone): string {
  const from = new Date(tombstone.timeRange.from).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const to = new Date(tombstone.timeRange.to).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const parts = [
    `[System: skipped ${tombstone.omittedCount} messages (${from}–${to}).`,
    `Participants: ${tombstone.participants.join(', ') || 'user'}.`,
    `Keywords: ${tombstone.keywords.join(', ') || 'N/A'}.`,
    `For details: ${tombstone.retrievalHints.join('; ')}]`,
  ];
  return parts.join(' ');
}

// --- Tool Payload Scrub ---

/**
 * F148: Scrub tool result payloads from non-terminal messages.
 * The last message's tool content is preserved verbatim.
 * Earlier messages with tool_result events get their content replaced with a digest line.
 */
export function scrubToolPayloads(messages: readonly StoredMessage[]): StoredMessage[] {
  if (messages.length === 0) return [];

  return messages.map((msg, i) => {
    // Last message: preserve verbatim
    if (i === messages.length - 1) return { ...msg };

    // Only scrub messages that have tool_result events
    if (!hasToolResult(msg)) return { ...msg };

    const toolLabel = msg.toolEvents?.find((e) => e.type === 'tool_result')?.label ?? 'tool';
    return {
      ...msg,
      content: `<tool_result truncated: ${toolLabel} executed>`,
    };
  });
}

// --- Phase C: Importance Scoring + Anchors ---

export interface ImportanceSignals {
  structural: number;
  positional: number;
  relevance: number;
}

export interface ScoredMessage {
  message: StoredMessage;
  score: number;
  signals: ImportanceSignals;
  isPrimacy: boolean;
}

/**
 * F148 Phase C: Score a single omitted message for importance.
 * Zero LLM cost — uses structural, positional, and keyword-relevance signals.
 */
export function scoreImportance(
  msg: StoredMessage,
  index: number,
  totalOmitted: number,
  queryTerms: string[],
): ScoredMessage {
  // Structural signals
  let structural = 0;
  if (/```[\s\S]*?```/.test(msg.content)) structural += 3; // code blocks
  if (msg.mentions.length > 0) structural += 2; // @-mentions
  if (msg.toolEvents && msg.toolEvents.length > 0) structural += 2; // tool events
  if (msg.content.length > 500) structural += 1; // substantial content

  // Positional signals
  let positional = 0;
  const isPrimacy = index === 0;
  if (isPrimacy) positional += 5; // thread opener

  // Relevance: count query term matches in content
  let relevance = 0;
  if (queryTerms.length > 0) {
    const lower = msg.content.toLowerCase();
    for (const term of queryTerms) {
      if (lower.includes(term)) relevance += 1;
    }
  }

  const signals: ImportanceSignals = { structural, positional, relevance };
  return { message: msg, score: structural + positional + relevance, signals, isPrimacy };
}

/**
 * F148 Phase C: Select top anchors from omitted messages.
 * Guarantees primacy anchor (index 0) is always included (AC-C3).
 * Returns anchors sorted by original index (chronological order).
 */
export function selectAnchors(
  omitted: readonly StoredMessage[],
  queryTerms: string[],
  maxAnchors = 3,
): ScoredMessage[] {
  if (omitted.length === 0 || maxAnchors <= 0) return [];

  const scored = omitted.map((msg, i) => scoreImportance(msg, i, omitted.length, queryTerms));
  const sorted = [...scored].sort((a, b) => b.score - a.score);

  // Take top N
  const selected = sorted.slice(0, maxAnchors);

  // Ensure primacy is included (AC-C3)
  const hasPrimacy = selected.some((s) => s.isPrimacy);
  if (!hasPrimacy && scored.length > 0) {
    const primacy = scored[0]; // index 0 = primacy
    selected.pop(); // remove lowest-scoring from selected
    selected.push(primacy);
  }

  // Sort by original index for chronological order in output
  const indexMap = new Map(omitted.map((m, i) => [m.id, i]));
  selected.sort((a, b) => (indexMap.get(a.message.id) ?? 0) - (indexMap.get(b.message.id) ?? 0));

  return selected;
}

/**
 * F148 Phase C: Format anchor messages as labeled context lines.
 */
export function formatAnchors(anchors: ScoredMessage[], truncateLimit: number): string[] {
  if (anchors.length === 0) return [];
  return anchors.map((a, i) => {
    const content =
      a.message.content.length > truncateLimit ? `${a.message.content.slice(0, truncateLimit)}...` : a.message.content;
    const speaker = a.message.source?.label || getSenderName(a.message.catId);
    const label = a.isPrimacy ? 'Thread opener' : `Anchor ${i + 1}/${anchors.length}`;
    return `[${label} @${speaker}: ${a.message.id}] ${content}`;
  });
}

// --- Evidence Recall ---

/** Minimal interface for evidence store search — matches IEvidenceStore.search signature */
interface EvidenceSearchable {
  search(query: string, options?: Record<string, unknown>): Promise<Array<{ title: string; summary?: string }>>;
}

/**
 * F148: Best-effort evidence recall for cold-mention context.
 * Composite query from thread title + current message + recent messages.
 * Configurable timeout, fail-open (returns [] on any error).
 */
export async function recallEvidence(
  evidenceStore: EvidenceSearchable | undefined,
  threadTitle: string,
  currentUserMessage: string,
  recentMessages: readonly StoredMessage[],
  config: HierarchicalContextConfig,
): Promise<string[]> {
  if (!evidenceStore) return [];

  try {
    // Build composite query from thread title + current message + recent non-system msgs
    const recentContent = recentMessages
      .filter((m) => m.content.length > 0)
      .slice(-2)
      .map((m) => m.content.slice(0, 200))
      .join(' ');
    const compositeQuery = [threadTitle, currentUserMessage.slice(0, 300), recentContent]
      .filter(Boolean)
      .join(' ')
      .trim();

    if (!compositeQuery) return [];

    // Race with timeout
    const searchPromise = evidenceStore.search(compositeQuery, { mode: 'hybrid' });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('evidence recall timeout')), config.evidenceRecallTimeoutMs),
    );

    const hits = await Promise.race([searchPromise, timeoutPromise]);
    return hits.slice(0, config.maxEvidenceHits).map((hit) => `[Evidence: ${hit.title}] ${hit.summary ?? ''}`.trim());
  } catch {
    // Fail-open: timeout or any error → return empty
    return [];
  }
}
