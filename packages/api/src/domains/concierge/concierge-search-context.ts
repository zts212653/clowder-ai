/**
 * ConciergeSearchContext (F229 KD-17 → KD-23)
 *
 * Pre-fetches search results in the routing pipeline (before model invocation),
 * numbers them R1-R{n}, returns handle table + formatted prompt context.
 *
 * KD-23: Handle table is a per-invocation flowing value — it flows from here
 * through request scope to buildConciergeActions. Zero shared storage.
 * HandleMapStore was the old design (KD-17); it caused cross-turn overwrites
 * because R1 had no identity dimension (which turn's R1?).
 *
 * Called once per concierge thread message. The duty cat sees numbered results
 * and copies a complete handle/title/digest marker into its reply.
 * The reply validator (concierge-reply-validator.ts) post-processes these markers
 * into CardBlock actions using the same handle table passed at call time.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Handle types (KD-23: moved from deleted ConciergeHandleMapStore.ts)
// ---------------------------------------------------------------------------

export interface HandleAnchor {
  threadId: string;
  messageId?: string;
  title: string;
  type: string; // 'thread' | 'feature' | 'message' | 'guide' | etc.
}

export interface HandleEntry {
  label: string; // R1, R2, ...
  anchor: HandleAnchor;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal evidence store interface (subset of IEvidenceStore) */
export interface ConciergeEvidenceStore {
  search(
    query: string,
    options?: { limit?: number; scope?: string; mode?: string; depth?: string },
  ): Promise<ConciergeEvidenceItem[]>;
}

/** Minimal evidence item (subset of EvidenceItem from memory/interfaces) */
export interface ConciergeEvidenceItem {
  anchor: string;
  title: string;
  kind: string;
  summary?: string;
  /** drillDown.params has normalized threadId + messageId (from SqliteEvidenceStore) */
  drillDown?: {
    tool: string;
    params: Record<string, string>;
    hint: string;
  };
}

export interface BuildConciergeSearchContextOptions {
  userMessage: string;
  threadId: string;
  evidenceStore?: ConciergeEvidenceStore;
  maxResults?: number;
}

export interface ConciergeSearchContextResult {
  /** Formatted context string for prompt injection. Empty if no results. */
  contextString: string;
  /** Number of handles in the table */
  handleCount: number;
  /** Handle table — per-invocation flowing value for buildConciergeActions (KD-23) */
  handles: HandleEntry[];
}

// ---------------------------------------------------------------------------
// Bound handle references (KD-25)
// ---------------------------------------------------------------------------

/** Separator used by the model-facing handle/title integrity binding. */
export const CONCIERGE_HANDLE_BINDING_SEPARATOR = '｜';
const CONCIERGE_HANDLE_UNTITLED_TITLE = '未命名记录';

/**
 * Canonicalize a title for use inside a bound handle reference.
 *
 * Titles remain user-visible through HandleAnchor.title. This canonical form is
 * only the integrity check copied into `[跳过去 Rn｜title｜digest]`; reserved marker
 * delimiters and newlines collapse to spaces so one title cannot escape the
 * marker grammar.
 */
export function normalizeConciergeHandleTitle(title: string): string {
  const normalized = title
    .normalize('NFKC')
    .replace(/[[\]\r\n|｜]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || CONCIERGE_HANDLE_UNTITLED_TITLE;
}

const CONCIERGE_HANDLE_MARKDOWN_SAFE_CHARS = {
  '\\': '＼',
  '`': '｀',
  '*': '＊',
  _: '＿',
  '(': '（',
  ')': '）',
  '~': '～',
  // P2 R3 (2026-07-11): angle-bracket autolink delimiters must be neutralized too.
  // remarkGfm expands `<https://url>` into a separate autolink node inside the
  // marker span, so the frontend marker regex can no longer see one contiguous
  // marker and the user gets a raw `[跳过去 R1｜...｜digest]` instead of the button.
  '<': '＜',
  '>': '＞',
} as const;

type ConciergeHandleMarkdownUnsafeChar = keyof typeof CONCIERGE_HANDLE_MARKDOWN_SAFE_CHARS;

/**
 * Format the canonical title field embedded in a bound handle reference.
 *
 * The validator NFKC-normalizes this text before comparing it to the anchor
 * title, so fullwidth punctuation keeps the semantic title equality while
 * preventing ReactMarkdown from splitting the marker before the frontend can
 * replace it with the inline button.
 */
export function formatConciergeHandleBindingTitle(title: string): string {
  return normalizeConciergeHandleTitle(title).replace(
    /[\\`*_()~<>]/g,
    (char) => CONCIERGE_HANDLE_MARKDOWN_SAFE_CHARS[char as ConciergeHandleMarkdownUnsafeChar],
  );
}

const CONCIERGE_HANDLE_DIGEST_LENGTH = 12;

/**
 * Compute a short collision-resistant identity proof for one numbered anchor.
 *
 * Including the label prevents a model from combining R2 with the otherwise
 * valid title/digest copied from R3. No state is stored: the validator
 * recomputes the digest from the same per-invocation HandleEntry.
 */
export function computeConciergeHandleDigest(handle: string, anchor: HandleAnchor): string {
  const identity = JSON.stringify([handle, anchor.type, anchor.threadId, anchor.messageId ?? null]);
  return createHash('sha256').update(identity).digest('hex').slice(0, CONCIERGE_HANDLE_DIGEST_LENGTH);
}

/** Format the complete model-facing reference for one per-invocation handle. */
export function formatConciergeHandleBinding(handle: string, anchor: HandleAnchor): string {
  const title = formatConciergeHandleBindingTitle(anchor.title);
  const digest = computeConciergeHandleDigest(handle, anchor);
  return `${handle}${CONCIERGE_HANDLE_BINDING_SEPARATOR}${title}${CONCIERGE_HANDLE_BINDING_SEPARATOR}${digest}`;
}

// ---------------------------------------------------------------------------
// Anchor parsing
// ---------------------------------------------------------------------------

/**
 * Parse evidence anchor + optional drillDown into HandleAnchor.
 *
 * Priority: drillDown.params (already normalized by SqliteEvidenceStore) > anchor parsing.
 *
 * Anchor formats (real memory index):
 * - "thread-thread_xyz" → threadId=thread_xyz, type=thread (IndexBuilder convention)
 * - "session-sess_123" → threadId=session-sess_123, type=session
 * - "feature:F229" → threadId=feature:F229, type=feature (best-effort)
 * - "docs/decisions/ADR-030.md" → threadId=docs/decisions/ADR-030.md, type=doc
 */
function parseAnchor(
  anchor: string,
  kind: string,
  title: string,
  drillDown?: ConciergeEvidenceItem['drillDown'],
): HandleAnchor {
  // Priority 1: drillDown.params has normalized IDs from SqliteEvidenceStore
  if (drillDown?.params?.threadId) {
    return {
      threadId: drillDown.params.threadId,
      ...(drillDown.params.messageId ? { messageId: drillDown.params.messageId } : {}),
      title,
      type: 'thread',
    };
  }

  // Priority 2: parse anchor string
  // Real memory index uses "thread-{threadId}" (with hyphen, not colon)
  if (anchor.startsWith('thread-')) {
    const threadId = anchor.slice('thread-'.length);
    return {
      threadId,
      title,
      type: 'thread',
    };
  }

  // Everything else: use the anchor as threadId, kind as type
  return {
    threadId: anchor,
    title,
    type: kind || 'doc',
  };
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 10;

/**
 * Pre-fetch search results, number them R1..R{n}, return handle table + prompt context.
 *
 * KD-23: No shared storage. Handle table flows through request scope.
 * Fail-open: if evidenceStore is unavailable or search throws, returns empty context.
 */
export async function buildConciergeSearchContext(
  options: BuildConciergeSearchContextOptions,
): Promise<ConciergeSearchContextResult> {
  const { userMessage, evidenceStore, maxResults = DEFAULT_MAX_RESULTS } = options;

  if (!evidenceStore) {
    return { contextString: '', handleCount: 0, handles: [] };
  }

  let items: ConciergeEvidenceItem[];
  try {
    // P1-A + P1-C (KD-19, AC-A3 recall): pass thread-scoped + hybrid + passage-level.
    // scope='threads' recalls discussion threads (AC-A3 finds discussions, not conclusion docs → teleport works);
    // depth='raw' yields passage-level messageId (peek requires it, was always skipped without it).
    items = await evidenceStore.search(userMessage, {
      limit: maxResults,
      scope: 'threads',
      mode: 'hybrid',
      depth: 'raw',
    });
  } catch {
    // Fail-open: search failure → empty context, no crash
    return { contextString: '', handleCount: 0, handles: [] };
  }

  if (items.length === 0) {
    return { contextString: '', handleCount: 0, handles: [] };
  }

  // Cap to maxResults
  const capped = items.slice(0, maxResults);

  // Build handle entries
  const handles: HandleEntry[] = capped.map((item, i) => ({
    label: `R${i + 1}`,
    anchor: parseAnchor(item.anchor, item.kind, item.title, item.drillDown),
  }));

  // Build formatted context string for prompt injection
  const lines: string[] = [
    '',
    '**搜索结果（复制完整标记；Rn、标题与末尾校验码必须来自同一条结果，否则不会生成按钮）：**',
  ];
  for (const h of handles) {
    const snippet = capped[Number.parseInt(h.label.slice(1), 10) - 1]?.summary ?? '';
    const snippetPart = snippet ? ` — ${snippet.slice(0, 80)}` : '';
    const binding = formatConciergeHandleBinding(h.label, h.anchor);
    lines.push(`- ${h.label}: 《${h.anchor.title}》(${h.anchor.type}) — 引用：[跳过去 ${binding}]${snippetPart}`);
  }
  lines.push('');

  return {
    contextString: lines.join('\n'),
    handleCount: handles.length,
    handles,
  };
}
