/**
 * F252 Phase B — Adaptive Pacing (AC-B1)
 *
 * Preprocessing layer that annotates ReplayEvents with pacing metadata:
 * - Idle gap detection: gaps > threshold → idleSkipMs annotation
 * - Pass-ball detection: @mention at line start / cross_post tool calls → isPassBall
 * - Idle gap compression: collapse long idle gaps to short display duration
 *
 * Pure functions — no side effects, no mutation of input arrays.
 */

import type { ReplayEvent } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default idle gap threshold: 5 minutes (ms) */
export const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000;

/** Default display duration for skipped idle gaps (ms) — brief visual beat */
export const DEFAULT_SKIP_DISPLAY_MS = 500;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AdaptivePacingConfig {
  /** Idle gap threshold in ms (gaps strictly greater than this are skipped) */
  idleThresholdMs?: number;
}

// ---------------------------------------------------------------------------
// Pass-ball detection
// ---------------------------------------------------------------------------

/**
 * Known cat handles for @mention detection.
 * Matches the Clowder AI roster — handles that appear in real transcripts.
 */
const CAT_HANDLES = [
  'opus',
  'sonnet',
  'codex',
  'gpt52',
  'spark',
  'gemini',
  'opus47',
  'opus48',
  'fable5',
  'gemini25',
  'gemini35',
  'you',
  'l\\.s\\.',
  'you',
  'antigravity',
  'antig-opus',
  'gpt-pro',
];

/**
 * Pattern: @handle at line start (or after markdown list/quote prefix).
 * Per shared-rules: "行首独立一行 @句柄" + "markdown 列表/引用前缀后合法"
 *
 * Matches:
 *   @codex
 *   - @gpt52 请 review
 *   > @opus47 确认
 *   1. @sonnet 测试
 *
 * Does NOT match:
 *   我觉得 @codex 应该看看   (mid-sentence)
 *   https://github.com/@someone (URL)
 */
const AT_MENTION_RE = new RegExp(
  `^(?:[-*>]\\s*|\\d+\\.\\s*)?@(?:${CAT_HANDLES.join('|')})(?!\\w)`,
  'm', // multiline — ^ matches start of any line
);

/**
 * Collaboration tool name suffixes that indicate pass-ball events.
 * Uses suffix matching (endsWith) instead of exact Set lookup to handle
 * both canonical "cat_cafe_cross_post_message" and short alias
 * "cross_post_message" (from mcp:cat-cafe/cross_post_message). Cloud R4
 * audit — same normalization gap as cross-feature-detector.ts.
 */
const PASS_BALL_SUFFIXES = ['cross_post_message', 'multi_mention'];

/**
 * Detect if an event is a pass-ball event.
 *
 * Pass-ball = routing action that hands off work to another cat:
 * - Message with @handle at line start (行首 @)
 * - cross_post_message / multi_mention tool calls
 * - post_message with @mention content
 *
 * Only checks 'message' and 'tool_call' types — system/thinking events
 * are never pass-ball actions.
 */
export function isPassBallEvent(event: ReplayEvent): boolean {
  if (event.type === 'message') {
    return AT_MENTION_RE.test(event.content);
  }

  if (event.type === 'tool_call') {
    const rawToolName = event.toolName ?? '';
    // Normalize MCP-prefixed tool names to bare form:
    // Codex: "mcp:server/tool_name" → "tool_name"
    // Claude Code: "mcp__server__tool_name" → "tool_name"
    const toolName = rawToolName.includes('/')
      ? rawToolName.split('/').pop()!
      : rawToolName.includes('__')
        ? rawToolName.split('__').pop()!
        : rawToolName;

    // Direct collaboration tools (suffix match for alias variants)
    if (PASS_BALL_SUFFIXES.some((suffix) => toolName.endsWith(suffix))) return true;

    // post_message with @mention or explicit targetCats — check event content + tool input
    if (toolName === 'cat_cafe_post_message') {
      if (AT_MENTION_RE.test(event.content)) return true;
      // Tool input may contain the posted message when event.content is empty (tool_use events)
      if (event.toolInput) {
        try {
          const input = JSON.parse(event.toolInput) as Record<string, unknown>;
          if (typeof input.content === 'string' && AT_MENTION_RE.test(input.content)) return true;
          // targetCats is explicit routing — always a pass-ball even without @mention
          if (Array.isArray(input.targetCats) && input.targetCats.length > 0) return true;
        } catch {
          // Non-JSON toolInput — check raw string as fallback
          if (AT_MENTION_RE.test(event.toolInput)) return true;
        }
      }
    }

    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

/**
 * Annotate events with adaptive pacing metadata.
 *
 * For each event, computes:
 * - idleSkipMs: if gap from previous event > threshold (strictly greater)
 * - isPassBall: if event matches pass-ball detection rules
 *
 * Returns a new array — original events are not mutated.
 */
export function annotateAdaptivePacing(events: ReplayEvent[], config?: AdaptivePacingConfig): ReplayEvent[] {
  const thresholdMs = config?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

  return events.map((event, i) => {
    const annotations: Partial<ReplayEvent> = {};

    // Idle gap detection (skip first event — it has no predecessor).
    // Exclude gaps after tool_call events — those are tool waits (e.g. long build/CI/API),
    // not idle gaps. Phase A log compression (compressEventTimestamps) handles them.
    if (i > 0 && events[i - 1].type !== 'tool_call') {
      const gap = event.timestamp - events[i - 1].timestamp;
      if (gap > thresholdMs) {
        annotations.idleSkipMs = gap;
      }
    }

    // Pass-ball detection
    if (isPassBallEvent(event)) {
      annotations.isPassBall = true;
    }

    // Only create a new object if there are annotations to add
    return Object.keys(annotations).length > 0 ? { ...event, ...annotations } : event;
  });
}

// ---------------------------------------------------------------------------
// Idle gap compression
// ---------------------------------------------------------------------------

/**
 * Compress idle gaps in the timeline to a short display duration.
 *
 * Events annotated with `idleSkipMs` (by annotateAdaptivePacing) have their
 * timestamps adjusted so the gap becomes `displayMs` instead of the original.
 * The `idleSkipMs` annotation is preserved for UI display ("⏩ 跳过 23 分钟").
 *
 * Non-idle gaps are preserved exactly.
 *
 * Returns a new array — original events are not mutated.
 */
export function compressIdleGaps(events: ReplayEvent[], displayMs: number = DEFAULT_SKIP_DISPLAY_MS): ReplayEvent[] {
  if (events.length <= 1) return events;

  const result: ReplayEvent[] = [events[0]];
  let compressedTimestamp = events[0].timestamp;

  for (let i = 1; i < events.length; i++) {
    const rawGap = events[i].timestamp - events[i - 1].timestamp;

    if (events[i].idleSkipMs != null) {
      // This event follows an idle gap — compress to display duration
      compressedTimestamp += displayMs;
    } else {
      // Normal gap — preserve original duration
      compressedTimestamp += rawGap;
    }

    result.push({ ...events[i], timestamp: compressedTimestamp });
  }

  return result;
}
