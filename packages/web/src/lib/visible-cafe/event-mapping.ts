/**
 * F258 Visible Café — Event Mapping (narrow set, §3 of plan)
 *
 * Pure functions that map server events to CatPresenceSnapshot updates.
 * Phase A semantic ruling:
 *   - F255 供血前主星猫恒 sleeping
 *   - 工作表达在窗外星球灯（star lights），不在主星猫
 *   - has_staged_thought 永不出现 (INV-3)
 *
 * "表情是 telemetry 不是演技" — no animation without state source.
 */

import type { CatPosture, ConfidenceLevel, PresenceState, StarCardSnapshot, ThreadMeta } from './presence-types';
import { STAR_CARD_IDLE_THRESHOLD_MS, STAR_CARD_WORKING_THRESHOLD_MS } from './presence-types';

/** The result of mapping a server event to a presence update. */
export interface MappedPresenceEvent {
  posture: CatPosture;
  hasStagedThought: boolean;
  confidence: ConfidenceLevel;
  sourceRef: string;
}

/**
 * Map an agent_message socket event to a presence update.
 *
 * Phase A semantic ruling (spec KD + plan §3):
 *   - ALL events map to sleeping for the main star cat
 *   - Work expression is ONLY in star window lights
 *   - has_staged_thought is ALWAYS false (INV-3, no F255 supply)
 *
 * This is not a bug — it's the design: 主星=家=下班,
 * 家里安安静静、窗外星光明灭, 正是"我不戳它不吵"的第一版兑现.
 */
export function mapAgentMessageToPresence(
  event: { id?: string; threadId?: string; type?: string },
  observedAt: number,
): MappedPresenceEvent {
  return {
    posture: 'sleeping',
    hasStagedThought: false, // INV-3: always false until F255
    confidence: 'socket',
    sourceRef: event.id ?? `socket:${observedAt}`,
  };
}

/**
 * Map a reconcile poll result to a presence update.
 * Reconcile is authoritative — confidence = 'reconciled'.
 *
 * Same Phase A semantic ruling applies: always sleeping.
 */
export function mapReconcileToPresence(
  _activeThreads: { threadId: string; lastActivity?: number }[],
  observedAt: number,
): MappedPresenceEvent {
  return {
    posture: 'sleeping',
    hasStagedThought: false, // INV-3: always false until F255
    confidence: 'reconciled',
    sourceRef: `reconcile:${observedAt}`,
  };
}

/**
 * Derive star light brightness from thread activity recency.
 * Returns 0..1 where 1 = just active, 0 = cold.
 */
export function threadActivityToBrightness(
  lastActivityAt: number,
  now: number,
  decayMs: number = 300_000, // 5 minutes full decay
): number {
  if (lastActivityAt <= 0) return 0;
  const age = now - lastActivityAt;
  if (age <= 0) return 1;
  if (age >= decayMs) return 0;
  return 1 - age / decayMs;
}

/**
 * Phase B: Derive per-thread cat posture from activity recency.
 *
 * U1 red line: this maps ONE thread to ONE cat's posture.
 * Never aggregate across threads — each star card is its own window.
 *
 * Mapping (recency-based, Phase B first cut):
 *   lastActiveAt within 30s → working (cat is actively doing something)
 *   lastActiveAt within 2min → idle (recently active, pausing)
 *   older → sleeping (thread quiet)
 *
 * "表情是 telemetry 不是演技" — posture reflects measured recency,
 * not a guess about what tool is being used.
 */
export function deriveStarCardSnapshot(meta: ThreadMeta, now: number): StarCardSnapshot {
  const age = now - meta.lastActiveAt;
  let posture: CatPosture;
  let state: PresenceState;

  if (meta.lastActiveAt <= 0 || age >= STAR_CARD_IDLE_THRESHOLD_MS) {
    posture = 'sleeping';
    state = age < 300_000 ? 'stale' : 'unknown'; // 5min decay matches star brightness
  } else if (age < STAR_CARD_WORKING_THRESHOLD_MS) {
    posture = 'working';
    state = 'live';
  } else {
    posture = 'idle';
    state = 'live';
  }

  return {
    threadId: meta.threadId,
    title: meta.title,
    posture,
    state,
    catId: meta.preferredCats?.[0] ?? meta.participants[0] ?? 'unknown',
    lastActiveAt: meta.lastActiveAt,
    sourceRef: `reconcile:thread:${meta.threadId}:${meta.lastActiveAt}`,
  };
}

/**
 * Hash a threadId to a stable (x, y) position in [0, 1] × [0, 1].
 * Deterministic — same threadId always gets the same position.
 */
export function hashThreadIdToPosition(threadId: string): { x: number; y: number } {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < threadId.length; i++) {
    const c = threadId.charCodeAt(i);
    h1 = ((h1 ^ c) * 0x1000193) >>> 0;
    h2 = ((h2 ^ c) * 0x811c9dc5) >>> 0;
  }
  return {
    x: (h1 & 0x7fffffff) / 0x7fffffff,
    y: (h2 & 0x7fffffff) / 0x7fffffff,
  };
}
