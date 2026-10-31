import type { AbstractiveInput, AbstractiveResult, DurableCandidate } from './abstractive-summary-types.js';

// ─── Parse natural language output into structured segments ─────
/** @internal Exported for testing only */
export function parseNaturalLanguageOutput(text: string, input: AbstractiveInput): AbstractiveResult | null {
  if (!text || text.trim().length < 10) return null;

  // Extract title: first line starting with # or ## or ### or **bold title**
  const titleMatch = text.match(/^#{1,3}\s+(.+)$/m) || text.match(/^\*\*(.+?)\*\*/m);
  let topicLabel: string;
  let titleEnd: number;

  if (titleMatch) {
    topicLabel = titleMatch[1].trim();
    titleEnd = text.indexOf(titleMatch[0]) + titleMatch[0].length;
  } else {
    // Fallback: use first non-empty line as title, or generate from thread ID
    const firstLine = text.trim().split('\n')[0]?.trim();
    topicLabel =
      firstLine && firstLine.length > 5 && firstLine.length < 200
        ? firstLine.replace(/^[-*>\s]+/, '').slice(0, 80)
        : `Thread ${input.threadId.slice(7, 19)} Summary`;
    titleEnd = firstLine ? text.indexOf(firstLine) + firstLine.length : 0;
  }

  const topicKey = topicLabel
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  // Extract summary: text between title and [decision!?]/[lesson!?]/[method!?] or end
  const candidateStart = text.search(/\n##\s+Durable|\n\[(decision|lesson|method)!?\]/i);
  const summaryText =
    candidateStart > titleEnd ? text.slice(titleEnd, candidateStart).trim() : text.slice(titleEnd).trim();

  // Clean up summary: remove markdown headers, keep plain text
  const summary = summaryText
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  // If no summary extracted, use the whole text as summary
  if (!summary) {
    const fallback = text
      .replace(/^#{1,3}\s+.+$/m, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!fallback) return null;
    return buildSingleSegment(topicLabel, topicKey, fallback, [], input);
  }

  // Extract candidates: [decision], [lesson], [method] tags
  const candidates = extractCandidates(text, input);
  return buildSingleSegment(topicLabel, topicKey, summary, candidates, input);
}

// Reject gate: candidates that are implementation details, not durable knowledge
const CODE_ACTION_RE =
  /^(加了?|改了?|删除?了?|重写|修复|调整|更新|移除|添加|replaced|rewrote|added|removed|changed|fixed|updated|moved)[\s\u4e00-\u9fff]/i;
const CODE_ARTIFACT_RE =
  /\b(regex|parser|schema|route|component|endpoint|middleware|handler|migration|refactor|writeFile|readFile|mkdir|JSON\.parse|tsc|lint)\b/i;
const FILE_EXT_RE = /\w+\.(tsx?|jsx?|mjs|cjs)\b/;
const CODE_IDENT_RE = /\b[a-z]+[A-Z]\w*/;
const MIN_TITLE_LENGTH = 8;

/** @internal Exported for testing only */
export function isImplementationNoise(title: string, claim: string): boolean {
  const text = `${title} ${claim}`;
  if (title.length < MIN_TITLE_LENGTH) return true;
  if (CODE_ACTION_RE.test(title)) return true;
  if (FILE_EXT_RE.test(title)) return true;
  if (CODE_IDENT_RE.test(title)) return true;
  // If title+claim contain multiple code artifacts, reject
  const artifactHits = (text.match(new RegExp(CODE_ARTIFACT_RE.source, 'gi')) || []).length;
  return artifactHits >= 2;
}

/** @internal Exported for testing only */
export const MAX_CANDIDATES_PER_SEGMENT = 2;

function extractCandidates(text: string, input: AbstractiveInput): DurableCandidate[] {
  const candidates: DurableCandidate[] = [];
  // Match [decision!] (explicit) or [decision] (inferred) — the ! suffix signals human confirmation
  const candidateRegex = /\[(decision|lesson|method)(!?)\]\s*(.+?)(?:\s*[—–-]\s*(.+))?$/gim;
  for (const match of text.matchAll(candidateRegex)) {
    const kind = match[1].toLowerCase() as 'decision' | 'lesson' | 'method';
    const isExplicit = match[2] === '!';
    const sourceMatch = match[0].match(/\s*\[sources:\s*([^\]]+)\]\s*$/i);
    const ids = [...new Set(sourceMatch?.[1].split(',').map((id) => id.trim()) ?? [])];
    // The program validates model-selected sources; it never guesses a source.
    if (ids.length === 0 || ids.some((id) => !input.messages.some((message) => message.id === id))) continue;
    const title = match[3].replace(/\s*\[sources:[^\]]+\]\s*$/i, '').trim();
    const claim = match[4]?.replace(/\s*\[sources:[^\]]+\]\s*$/i, '').trim() || title;
    // Lightweight reject gate: skip implementation noise
    if (isImplementationNoise(title, claim)) continue;
    candidates.push({
      kind,
      title,
      claim,
      why_durable: 'Extracted from thread summary',
      evidence: ids.map((messageId) => ({ threadId: input.threadId, messageId, span: '' })),
      relatedAnchors: [],
      confidence: isExplicit ? 'explicit' : 'inferred',
    });
  }
  // Cap: keep only the most confident candidates (explicit first, then by order)
  if (candidates.length > MAX_CANDIDATES_PER_SEGMENT) {
    candidates.sort((a, b) => (a.confidence === 'explicit' ? 0 : 1) - (b.confidence === 'explicit' ? 0 : 1));
    candidates.length = MAX_CANDIDATES_PER_SEGMENT;
  }
  return candidates;
}

function buildSingleSegment(
  topicLabel: string,
  topicKey: string,
  summary: string,
  candidates: DurableCandidate[],
  input: AbstractiveInput,
): AbstractiveResult | null {
  const firstMsg = input.messages[0];
  const lastMsg = input.messages[input.messages.length - 1];
  if (!firstMsg || !lastMsg) return null;

  return {
    segments: [
      {
        summary,
        topicKey,
        topicLabel,
        boundaryReason: 'single batch',
        boundaryConfidence: 'high',
        fromMessageId: firstMsg.id,
        toMessageId: lastMsg.id,
        messageCount: input.messages.length,
        candidates: candidates.length > 0 ? candidates : undefined,
      },
    ],
  };
}
