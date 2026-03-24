/**
 * F22: Rich Blocks 富消息系统 — 类型定义
 *
 * 富块是派生的交互组件（card / diff / checklist / media_gallery），
 * 与 contentBlocks（LLM 原始输出）语义不同，存储在 extra.rich 中。
 */

// ── Block Kinds ─────────────────────────────────────────────

export type RichBlockKind =
  | 'card'
  | 'diff'
  | 'checklist'
  | 'media_gallery'
  | 'audio'
  | 'interactive'
  | 'html_widget'
  | 'file';

// ── Base ────────────────────────────────────────────────────

export interface RichBlockBase {
  /** Message-local stable id (e.g. "b1") */
  id: string;
  kind: RichBlockKind;
  /** Schema version — always 1 for now */
  v: 1;
}

// ── Concrete Blocks ─────────────────────────────────────────

/** F066 Phase 4: Card action button (e.g. "重新合成" on TTS failure cards) */
export interface CardAction {
  label: string;
  /** Action identifier — frontend dispatches based on this */
  action: string;
  /** Opaque payload for the action handler */
  payload?: Record<string, unknown>;
}

export interface RichCardBlock extends RichBlockBase {
  kind: 'card';
  title: string;
  bodyMarkdown?: string;
  tone?: 'info' | 'success' | 'warning' | 'danger';
  fields?: Array<{ label: string; value: string }>;
  /** F066 Phase 4: Optional action buttons displayed at the bottom of the card */
  actions?: CardAction[];
}

export interface RichDiffBlock extends RichBlockBase {
  kind: 'diff';
  filePath: string;
  /** Unified diff text */
  diff: string;
  languageHint?: string;
}

export interface RichChecklistBlock extends RichBlockBase {
  kind: 'checklist';
  title?: string;
  items: Array<{ id: string; text: string; checked?: boolean }>;
}

export interface RichMediaGalleryBlock extends RichBlockBase {
  kind: 'media_gallery';
  title?: string;
  items: Array<{ url: string; alt?: string; caption?: string }>;
}

/** F34: Audio block for TTS playback or audio content.
 *  F34-b: When `text` is set, this is a voice message — backend auto-synthesizes
 *  and fills `url` before storage. */
export interface RichAudioBlock extends RichBlockBase {
  kind: 'audio';
  url: string;
  /** F34-b: Voice message text (what the cat "said"). Present = voice message style. */
  text?: string;
  /** F085-P3: Override voice — use this cat's voice instead of the message sender's.
   *  Enables multi-cat voice in a single message (e.g. three cats taking turns). */
  speaker?: string;
  title?: string;
  durationSec?: number;
  mimeType?: string;
}

/** F096: Interactive rich block — user can select/confirm within the block */
export interface InteractiveOption {
  id: string;
  label: string;
  emoji?: string;
  /** SVG icon name from the café icon set — preferred over emoji for visual consistency */
  icon?: string;
  description?: string;
  level?: number;
  group?: string;
  /** When true, selecting this option shows a text input for custom user input */
  customInput?: boolean;
  /** Placeholder text for the custom input field */
  customInputPlaceholder?: string;
}

export interface RichInteractiveBlock extends RichBlockBase {
  kind: 'interactive';
  interactiveType: 'select' | 'multi-select' | 'card-grid' | 'confirm';
  title?: string;
  description?: string;
  options: InteractiveOption[];
  maxSelect?: number;
  allowRandom?: boolean;
  messageTemplate?: string;
  disabled?: boolean;
  selectedIds?: string[];
  /** Phase C: blocks sharing the same groupId are submitted together */
  groupId?: string;
}

/** F088 Phase J: File attachment block — generated document or uploaded file.
 *  Backend resolves `url` to absolute path for outbound delivery. */
export interface RichFileBlock extends RichBlockBase {
  kind: 'file';
  /** Local URL (e.g. /uploads/report.pdf) — resolved to absPath by mediaPathResolver */
  url: string;
  /** Display name shown to user (e.g. "调研报告.pdf") */
  fileName: string;
  /** MIME type (e.g. application/pdf) — used for file_type mapping */
  mimeType?: string;
  /** File size in bytes — informational */
  fileSize?: number;
}

/** F120 Phase C: Inline HTML/JS widget rendered in sandboxed iframe (srcdoc).
 *  Similar to Claude.ai's visualize:show_widget — for charts, calculators, etc. */
export interface RichHtmlWidgetBlock extends RichBlockBase {
  kind: 'html_widget';
  /** Complete HTML document or fragment to render */
  html: string;
  /** Optional title displayed above the widget */
  title?: string;
  /** iframe height in px (default: 300) */
  height?: number;
}

// ── Union ───────────────────────────────────────────────────

export type RichBlock =
  | RichCardBlock
  | RichDiffBlock
  | RichChecklistBlock
  | RichMediaGalleryBlock
  | RichAudioBlock
  | RichInteractiveBlock
  | RichHtmlWidgetBlock
  | RichFileBlock;

// ── Container (stored in StoredMessage.extra.rich) ──────────

export interface RichMessageExtra {
  v: 1;
  blocks: RichBlock[];
}

// ── Normalization (#85 format tolerance) ────────────────────

const VALID_KINDS: readonly string[] = [
  'card',
  'diff',
  'checklist',
  'media_gallery',
  'audio',
  'interactive',
  'html_widget',
  'file',
];

/**
 * #85: Normalize a raw rich block object (mutating).
 * - `type → kind` alias: if object has `type` but not `kind`, and `type` is a valid kind → rename
 * - Auto-fill `v: 1`: if object has `kind` but no `v` field → add `v: 1`
 */
export function normalizeRichBlock(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;

  // type → kind alias
  if ('type' in obj && !('kind' in obj)) {
    if (VALID_KINDS.includes(obj['type'] as string)) {
      obj['kind'] = obj['type'];
      delete obj['type'];
    }
  }

  // Auto-fill v: 1
  if (!('v' in obj) && 'kind' in obj) {
    obj['v'] = 1;
  }

  return obj;
}
