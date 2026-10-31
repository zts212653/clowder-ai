/**
 * F227: Event Memory — terminal typed model for cognitive-transition events.
 *
 * Source of truth: docs/discussions/2026-06-06-f227-design-gate.md
 *   "新增 EventMemory typed model，使用终态 10 字段：
 *    type, trigger, cat, threadId, messageId, timestamp, summary,
 *    cognitiveTransition, relatedHarness, confidence."
 *
 * Event Memory is the SINGLE SOURCE OF TRUTH for magic-word cognitive-transition
 * events (归一裁定 2026-06-06). F192 MagicWordRecord becomes a projection subset.
 *
 * Design notes:
 * - `EventMemoryRecord` is the terminal 10-field business shape (validated by the
 *   No-Scaffold gate). `cognitiveTransition` / `relatedHarness` are nullable, but
 *   the KEY must be present — writers explicitly declare "no transition" = null,
 *   never silently omit (terminal-shape discipline).
 * - `eventId` is NOT one of the 10 business fields: it is the persistence primary
 *   key minted by the store layer (mirrors FrustrationIssue.issueId). The 归一
 *   contract — "先写 Event store 拿到 eventId，再 append 轻量 magic_word_ref{eventId}"
 *   — relies on the store returning eventId, so it lives on `StoredEventMemory`.
 */

import { generateId } from './ids.js';

// ── Enums (single source: const array → type) ──────────────────────

/** Five collection signals (五类信号). */
export const EVENT_TRIGGERS = [
  'human_brake', // co-creator拉闸（magic word 等人工信号）
  'cat_brake', // 猫主动刹车
  'cat_shout', // 猫喊回 / 互相提醒
  'flywheel_selffix', // 自进化 / 自修复
  'lesson_settle', // 教训沉淀
] as const;
export type EventTrigger = (typeof EVENT_TRIGGERS)[number];

/** Cognitive-state transition enum (OQ-2: stable but nullable). */
export const COGNITIVE_TRANSITIONS = [
  'user_brake',
  'self_brake',
  'coordinate_correction',
  'capability_gap',
  'scope_correction',
  'aha',
  'repeated_need',
  'harness_internalized',
  'lesson_crystallized',
] as const;
export type CognitiveTransition = (typeof COGNITIVE_TRANSITIONS)[number];

export const EVENT_CONFIDENCES = ['high', 'mid', 'low'] as const;
export type EventConfidence = (typeof EVENT_CONFIDENCES)[number];

// ── Terminal 10-field record ───────────────────────────────────────

export interface EventMemoryRecord {
  /** 事件类型（magic word slug / 'cat_declared' / ...）. */
  type: string;
  /** 五类信号. */
  trigger: EventTrigger;
  /** 当事猫 catId（人工拉闸时为触发猫 / 'unknown'）. */
  cat: string;
  /** teleport 坐标. */
  threadId: string;
  /** teleport 坐标（精确到 message）. */
  messageId: string;
  timestamp: number;
  /** 原话摘要. */
  summary: string;
  /** nullable — 不为 Phase A 强猜 aha. KEY 必须存在. */
  cognitiveTransition: CognitiveTransition | null;
  /** commit/hook/skill/rule 锚点（Phase C 填）. KEY 必须存在. */
  relatedHarness: string[] | null;
  confidence: EventConfidence;
}

/**
 * Persisted record: terminal 10 semantic fields + store-minted primary key + owner
 * scope metadata.
 *
 * `ownerUserId` is NOT a cognitive field (cloud-review P1 / 砚砚) — it is the storage/auth
 * boundary: which cocreator's Event Memory this row belongs to. It lets reads be
 * owner-scoped so the shared `default` thread can't leak one user's brake events to
 * another. The 10 semantic fields (and their `isEventMemoryRecord` guard) are unchanged.
 */
export interface StoredEventMemory extends EventMemoryRecord {
  eventId: string;
  ownerUserId: string;
}

/** A non-empty owner scope (auth principal). Writers MUST supply one — no fallback (砚砚). */
export function isValidOwnerUserId(value: unknown): value is string {
  return isNonEmptyString(value);
}

// ── ID generator ───────────────────────────────────────────────────

export type EventMemoryId = string;

export function generateEventId(): EventMemoryId {
  return generateId('evt');
}

// ── Guard (validates detector/backfill/mark_event output) ──────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Nullable enum field: value is null or a legal member. */
function isNullOrMember<T>(value: unknown, allowed: readonly T[]): boolean {
  return value === null || allowed.includes(value as T);
}

/** Nullable string[] field: value is null or a string array. */
function isNullOrStringArray(value: unknown): boolean {
  return value === null || isStringArray(value);
}

/**
 * Runtime guard for untrusted input (backfill rows, detector output, MCP payloads).
 * Enforces the terminal 10-field shape + enum legality. cognitiveTransition /
 * relatedHarness are nullable but their KEY must be present (terminal-shape discipline).
 */
export function isEventMemoryRecord(value: unknown): value is EventMemoryRecord {
  if (!isPlainObject(value)) return false;

  if (!isNonEmptyString(value.type)) return false;
  if (!isNonEmptyString(value.cat)) return false;
  if (!isNonEmptyString(value.threadId)) return false;
  if (!isNonEmptyString(value.messageId)) return false;
  if (typeof value.summary !== 'string') return false;
  if (!isFiniteNumber(value.timestamp)) return false;
  if (!EVENT_TRIGGERS.includes(value.trigger as EventTrigger)) return false;
  if (!EVENT_CONFIDENCES.includes(value.confidence as EventConfidence)) return false;

  if (!('cognitiveTransition' in value) || !isNullOrMember(value.cognitiveTransition, COGNITIVE_TRANSITIONS)) {
    return false;
  }
  if (!('relatedHarness' in value) || !isNullOrStringArray(value.relatedHarness)) {
    return false;
  }

  return true;
}
