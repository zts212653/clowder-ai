/**
 * F236 Phase A — Anchor-first projection helpers for callback routes.
 *
 * These run at the INNERMOST callback-route projection layer (AC-A5), so HTTP /
 * agent-key / MCP callers all receive anchorized previews instead of full bodies.
 * MCP handlers stay pass-through (they forward route JSON verbatim).
 *
 * Honesty contract (变瞎子 gate / 信息完整性): every truncated field is
 * explicitly flagged (`truncated` / `requiresDrill` / `whyTruncated`) and carries
 * a low-cost, one-hop `drillDown` pointer back to the full content — a preview
 * must never pretend to be the whole thing.
 */

import type { MessageContent, RichBlock, RichBlockKind, TaskItem } from '@cat-cafe/shared';

/** Per-field and per-message bounds so richBlocksSummary always fits well inside the 24KB envelope. */
const RICH_SUMMARY_ID_MAX_CHARS = 64;
const RICH_SUMMARY_TITLE_MAX_CHARS = 120;
const RICH_SUMMARY_MIME_MAX_CHARS = 80;
const RICH_SUMMARY_MAX_ITEMS = 8;
const RICH_SUMMARY_MAX_BYTES = 1_600;

const VALID_CARD_TONES = new Set<NonNullable<RichBlockSummaryItem['tone']>>(['info', 'success', 'warning', 'danger']);
const VALID_INTERACTIVE_TYPES = new Set<NonNullable<RichBlockSummaryItem['interactiveType']>>([
  'select',
  'multi-select',
  'card-grid',
  'confirm',
]);

export interface RichBlockSummaryItem {
  id: string;
  kind: RichBlockKind;
  summaryTruncated?: true;
  title?: string;
  htmlLength?: number;
  height?: number;
  tone?: 'info' | 'success' | 'warning' | 'danger';
  bodyLength?: number;
  fieldCount?: number;
  itemCount?: number;
  interactiveType?: 'select' | 'multi-select' | 'card-grid' | 'confirm';
  optionCount?: number;
  filePath?: string;
  diffLength?: number;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  durationSec?: number;
  textLength?: number;
}

export interface RichBlocksSummaryProjection {
  richBlocksSummary?: RichBlockSummaryItem[];
  richBlocksTotalCount?: number;
  richBlocksOmittedCount?: number;
  richBlocksSummaryTruncated?: true;
}

function summarizeSingleRichBlock(block: RichBlock): RichBlockSummaryItem | undefined {
  if (!block || typeof block !== 'object' || typeof block.id !== 'string') return undefined;
  const idCut = truncateHead(block.id, RICH_SUMMARY_ID_MAX_CHARS);
  let itemTruncated = idCut.truncated;
  let baseTitle: { title?: string } = {};
  if ('title' in block && typeof block.title === 'string' && block.title.length > 0) {
    const titleCut = truncateHead(block.title, RICH_SUMMARY_TITLE_MAX_CHARS);
    itemTruncated = itemTruncated ? true : titleCut.truncated;
    baseTitle = { title: titleCut.preview };
  }

  switch (block.kind) {
    case 'html_widget':
      return {
        id: idCut.preview,
        kind: block.kind,
        ...baseTitle,
        htmlLength: typeof block.html === 'string' ? block.html.length : 0,
        ...(typeof block.height === 'number' && Number.isFinite(block.height) ? { height: block.height } : {}),
        ...(itemTruncated ? { summaryTruncated: true } : {}),
      };
    case 'card':
      return {
        id: idCut.preview,
        kind: block.kind,
        ...baseTitle,
        ...(block.tone && VALID_CARD_TONES.has(block.tone) ? { tone: block.tone } : {}),
        ...(typeof block.bodyMarkdown === 'string' && block.bodyMarkdown.length > 0
          ? { bodyLength: block.bodyMarkdown.length }
          : {}),
        ...(Array.isArray(block.fields) && block.fields.length > 0 ? { fieldCount: block.fields.length } : {}),
        ...(itemTruncated ? { summaryTruncated: true } : {}),
      };
    case 'checklist':
    case 'media_gallery':
      return {
        id: idCut.preview,
        kind: block.kind,
        ...baseTitle,
        itemCount: Array.isArray(block.items) ? block.items.length : 0,
        ...(itemTruncated ? { summaryTruncated: true } : {}),
      };
    case 'interactive':
      return {
        id: idCut.preview,
        kind: block.kind,
        ...baseTitle,
        ...(VALID_INTERACTIVE_TYPES.has(block.interactiveType) ? { interactiveType: block.interactiveType } : {}),
        optionCount: Array.isArray(block.options) ? block.options.length : 0,
        ...(itemTruncated ? { summaryTruncated: true } : {}),
      };
    case 'diff': {
      const pathCut = truncateHead(
        typeof block.filePath === 'string' ? block.filePath : '',
        RICH_SUMMARY_TITLE_MAX_CHARS,
      );
      itemTruncated = itemTruncated ? true : pathCut.truncated;
      return {
        id: idCut.preview,
        kind: block.kind,
        filePath: pathCut.preview,
        diffLength: typeof block.diff === 'string' ? block.diff.length : 0,
        ...(itemTruncated ? { summaryTruncated: true } : {}),
      };
    }
    case 'file': {
      const nameCut = truncateHead(
        typeof block.fileName === 'string' ? block.fileName : '',
        RICH_SUMMARY_TITLE_MAX_CHARS,
      );
      itemTruncated = itemTruncated ? true : nameCut.truncated;
      let mimeField: { mimeType?: string } = {};
      if (typeof block.mimeType === 'string' && block.mimeType.length > 0) {
        const mimeCut = truncateHead(block.mimeType, RICH_SUMMARY_MIME_MAX_CHARS);
        itemTruncated = itemTruncated ? true : mimeCut.truncated;
        mimeField = { mimeType: mimeCut.preview };
      }
      return {
        id: idCut.preview,
        kind: block.kind,
        fileName: nameCut.preview,
        ...mimeField,
        ...(typeof block.fileSize === 'number' && Number.isFinite(block.fileSize) ? { fileSize: block.fileSize } : {}),
        ...(itemTruncated ? { summaryTruncated: true } : {}),
      };
    }
    case 'audio':
      return {
        id: idCut.preview,
        kind: block.kind,
        ...baseTitle,
        ...(typeof block.durationSec === 'number' && Number.isFinite(block.durationSec)
          ? { durationSec: block.durationSec }
          : {}),
        ...(typeof block.text === 'string' && block.text.length > 0 ? { textLength: block.text.length } : {}),
        ...(itemTruncated ? { summaryTruncated: true } : {}),
      };
  }
  return undefined;
}

/**
 * Project attached rich blocks (`extra.rich.blocks`) into strictly bounded metadata
 * (item count, per-string length, and UTF-8 byte cap) so preview/anchor/oversized
 * modes always fit inside the 24KB envelope while honestly flagging any summary omission.
 */
export function projectRichBlocksSummary(blocks: readonly RichBlock[] | undefined): RichBlocksSummaryProjection {
  if (!blocks?.length) return {};
  const summary: RichBlockSummaryItem[] = [];
  let usedBytes = 2; // '[' + ']'
  let anyItemTruncated = false;

  for (const block of blocks) {
    if (summary.length >= RICH_SUMMARY_MAX_ITEMS) break;
    const item = summarizeSingleRichBlock(block);
    if (!item) {
      anyItemTruncated = true;
      continue;
    }
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + (summary.length > 0 ? 1 : 0);
    if (summary.length > 0 && usedBytes + itemBytes > RICH_SUMMARY_MAX_BYTES) break;
    summary.push(item);
    usedBytes += itemBytes;
    if (item.summaryTruncated) anyItemTruncated = true;
  }

  const omittedCount = blocks.length - summary.length;
  const summaryTruncated = omittedCount > 0 ? true : anyItemTruncated;
  return {
    richBlocksSummary: summary,
    ...(omittedCount > 0
      ? {
          richBlocksTotalCount: blocks.length,
          richBlocksOmittedCount: omittedCount,
        }
      : {}),
    ...(summaryTruncated ? { richBlocksSummaryTruncated: true } : {}),
  };
}

export function summarizeRichBlocks(blocks: readonly RichBlock[] | undefined): RichBlockSummaryItem[] | undefined {
  return projectRichBlocksSummary(blocks).richBlocksSummary;
}

/** Semantic text extracted from rich blocks for bounded keyword relevance scoring. */
export function callbackRichSearchText(blocks: readonly RichBlock[] | undefined): string {
  if (!blocks?.length) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    parts.push(block.kind);
    if ('title' in block && block.title) parts.push(block.title);
    if (block.kind === 'card' && block.bodyMarkdown) parts.push(block.bodyMarkdown);
    if (block.kind === 'file') parts.push(block.fileName);
    if (block.kind === 'diff') parts.push(block.filePath);
    if (block.kind === 'checklist') {
      for (const entry of block.items) parts.push(entry.text);
    }
  }
  return parts.join('\n');
}

/** Read-only search/preview text. Full drills retain raw content and structured provenance. */
export function callbackMessageText(item: { content: string; contentBlocks?: readonly MessageContent[] }): string {
  const parts = [item.content];
  for (const block of item.contentBlocks ?? []) {
    if (block.type !== 'context_attachment' || block.attachment.kind !== 'quote') continue;
    const quote = block.attachment;
    // The paired comment is the user's intent; a long quoted source must not
    // consume the head preview before that intent becomes visible.
    if (quote.comment !== undefined) parts.push(`[评论]\n${quote.comment}`);
    parts.push(`[引用]\n${quote.text}`);
  }
  return parts.filter((part) => part.length > 0).join('\n\n');
}

/** Max chars kept in an anchor preview (~70 tokens). Single tunable source. */
export const PREVIEW_MAX_CHARS = 280;

export interface TruncateResult {
  preview: string;
  truncated: boolean;
}

/** Head-only truncation: keep the first `max` chars. Used for thread-context + task why. */
export function truncateHead(text: string, max: number = PREVIEW_MAX_CHARS): TruncateResult {
  if (text.length <= max) return { preview: text, truncated: false };
  return { preview: text.slice(0, max), truncated: true };
}

/**
 * Head+tail truncation: keep the first ~half and last ~half, with an honest
 * omission marker in the middle. Used for pending mentions where the actionable
 * handoff instruction (e.g. "@sonnet take over now") often sits at the END.
 */
export function truncateHeadTail(text: string, max: number = PREVIEW_MAX_CHARS): TruncateResult {
  if (text.length <= max) return { preview: text, truncated: false };
  const headLen = Math.ceil(max / 2);
  const tailLen = max - headLen;
  const omitted = text.length - headLen - tailLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  return { preview: `${head}…[+${omitted} chars]…${tail}`, truncated: true };
}

/**
 * Keyword-aware truncation (F236 R1 / 砚砚 P1 anti-变瞎子): when a result is
 * surfaced BECAUSE it matched a keyword, the preview must show WHY it matched.
 * Centers the preview window on the first keyword hit; honestly marks the omitted
 * head/tail char counts. Falls back to head-only when no term is found.
 */
export function truncateAroundMatch(
  text: string,
  keywordTerms: readonly string[],
  max: number = PREVIEW_MAX_CHARS,
): TruncateResult {
  if (text.length <= max) return { preview: text, truncated: false };
  const lower = text.toLowerCase();
  let hitIdx = -1;
  for (const term of keywordTerms) {
    if (!term) continue;
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (hitIdx < 0 || idx < hitIdx)) hitIdx = idx;
  }
  if (hitIdx < 0) return truncateHead(text, max); // no hit → head-only fallback
  const half = Math.floor(max / 2);
  const start = Math.max(0, hitIdx - half);
  const end = Math.min(text.length, start + max);
  const head = start > 0 ? `…[+${start} chars]…` : '';
  const tail = end < text.length ? `…[+${text.length - end} chars]…` : '';
  return { preview: `${head}${text.slice(start, end)}${tail}`, truncated: true };
}

export interface MessageDrillDown {
  tool: 'cat_cafe_get_message';
  args: { messageId: string; mode: 'full'; agentKeyCatId?: string };
}

// F236 R1 / 云端 Codex P2: agent-key callers must carry agentKeyCatId on the drill call to
// resolve credentials. The server knows the caller principal, so it bakes the selector into
// the pointer → agent-key caller drills verbatim one-hop (invocation callers omit it).
function messageDrillDown(messageId: string, agentKeyCatId?: string): MessageDrillDown {
  return {
    tool: 'cat_cafe_get_message',
    args: { messageId, mode: 'full', ...(agentKeyCatId ? { agentKeyCatId } : {}) },
  };
}

/** Minimal message shape the anchor helpers read from. */
export interface AnchorableMessage {
  id: string;
  userId: string;
  catId: string | null;
  content: string;
  contentBlocks?: readonly MessageContent[];
  extra?: { rich?: { blocks?: readonly RichBlock[] } };
  timestamp: number;
}

export interface AnchoredThreadMessage extends RichBlocksSummaryProjection {
  id: string;
  threadId: string;
  timestamp: number;
  speaker: string;
  preview: string;
  contentLength: number;
  truncated: boolean;
  drillDown: MessageDrillDown;
  imagePaths?: string[];
  imageUrls?: string[];
}

/**
 * AC-A1/A2: project a thread-context message into a token-lean anchor.
 * - preview is keyword-aware when keywordTerms are supplied (F236 R1 / 砚砚 P1:
 *   a keyword-ranked result must show WHY it matched), else head-only
 * - injects effectiveThreadId at the item level (TD091 echo)
 * - speaker is supplied by the caller via the shared sender-display convention
 *   (getSenderName: human → co-creator, cat → displayName) — NEVER the raw internal
 *   userId (F236 R1 / 砚砚 P2: f148-navigation-context regression forbids leaking it)
 * - omits content/contentBlocks; keeps image hints as lightweight metadata
 */
export function anchorThreadMessage(
  item: AnchorableMessage,
  opts: {
    effectiveThreadId: string;
    speaker: string;
    keywordTerms?: readonly string[];
    agentKeyCatId?: string;
    imagePaths?: string[];
    imageUrls?: string[];
  },
): AnchoredThreadMessage {
  const text = callbackMessageText(item);
  const { preview, truncated: textTruncated } =
    opts.keywordTerms && opts.keywordTerms.length > 0
      ? truncateAroundMatch(text, opts.keywordTerms)
      : truncateHead(text);
  const richSummary = projectRichBlocksSummary(item.extra?.rich?.blocks);
  return {
    id: item.id,
    threadId: opts.effectiveThreadId,
    timestamp: item.timestamp,
    speaker: opts.speaker,
    preview,
    contentLength: text.length,
    truncated: richSummary.richBlocksSummary !== undefined ? true : textTruncated,
    drillDown: messageDrillDown(item.id, opts.agentKeyCatId),
    ...richSummary,
    ...(opts.imagePaths && opts.imagePaths.length > 0 ? { imagePaths: opts.imagePaths } : {}),
    ...(opts.imageUrls && opts.imageUrls.length > 0 ? { imageUrls: opts.imageUrls } : {}),
  };
}

export interface AnchoredPendingMention extends RichBlocksSummaryProjection {
  id: string;
  from: string;
  message: string;
  timestamp: number;
  contentLength: number;
  requiresDrill: boolean;
  drillDown: MessageDrillDown;
  acked?: boolean;
}

/**
 * AC-A3: project a pending mention with a head+tail actionable excerpt.
 * Keeps the `from`/`message` field names for semantic continuity, but `message`
 * is now an excerpt; `requiresDrill` flags truncation honestly. `from` is supplied
 * by the caller via the shared sender-display convention (never raw userId, F236 R1).
 */
export function anchorPendingMention(
  item: AnchorableMessage,
  opts: { from: string; acked?: boolean },
): AnchoredPendingMention {
  const { preview, truncated: textTruncated } = truncateHeadTail(item.content);
  const richSummary = projectRichBlocksSummary(item.extra?.rich?.blocks);
  return {
    id: item.id,
    from: opts.from,
    message: preview,
    timestamp: item.timestamp,
    contentLength: item.content.length,
    requiresDrill: richSummary.richBlocksSummary !== undefined ? true : textTruncated,
    drillDown: messageDrillDown(item.id),
    ...richSummary,
    ...(opts.acked !== undefined ? { acked: opts.acked } : {}),
  };
}

export interface TaskWhyDrillDown {
  tool: 'cat_cafe_list_tasks';
  args: { taskId: string };
}

export type AnchoredTask = TaskItem & {
  whyLength: number;
  whyTruncated: boolean;
  drillDown?: TaskWhyDrillDown;
};

/**
 * AC-A4: preview-ize the task `why` field ONLY (every other TaskItem field is
 * untouched — notably automationState, to avoid scope creep). When `full` is set
 * (drill via list_tasks?taskId=...), the complete why is returned verbatim.
 */
export function anchorTaskWhy(task: TaskItem, opts?: { full?: boolean }): AnchoredTask {
  const why = task.why ?? '';
  const { preview, truncated } = opts?.full ? { preview: why, truncated: false } : truncateHead(why);
  return {
    ...task,
    why: preview,
    whyLength: why.length,
    whyTruncated: truncated,
    ...(truncated ? { drillDown: { tool: 'cat_cafe_list_tasks', args: { taskId: task.id } } } : {}),
  };
}
