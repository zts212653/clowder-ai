/**
 * F247 Workspace Agent (R3b rework): stable outbound conversation key.
 *
 * The Workspace Agents Trigger API accepts a caller-defined
 * `conversation_key` that keeps server-side conversation continuity across
 * triggers. We derive it deterministically from the Clowder AI identity pair
 * so the same (workspace, thread) always resumes the same agent conversation
 * without any local URL binding — conversation continuity is owned by the
 * provider, not by thread metadata.
 *
 * Format: `clowder:{workspaceId}:{threadId}`
 *
 * astra R3b: there is exactly ONE segment predicate
 * (`isWorkspaceAgentConversationKeySegment`). The key builder, the full-key
 * validator, the Settings route, the persisted/env config parsers, and the
 * HTTP adapter all consume it — a value any consumer accepts is accepted by
 * all of them. The predicate rejects: empty, >256 chars, ':' (ambiguity),
 * all C0 controls (including NUL), DEL, and every Unicode whitespace.
 */

const KEY_PREFIX = 'clowder';
const MAX_SEGMENT_LENGTH = 256;
const SEGMENT_FORBIDDEN = /[\s]/u;

export interface WorkspaceAgentConversationKeyInput {
  readonly workspaceId: string;
  readonly threadId: string;
}

/**
 * The single segment predicate. Keep this in sync with nothing — everything
 * else syncs to it.
 */
export function isWorkspaceAgentConversationKeySegment(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_SEGMENT_LENGTH) return false;
  if (value.includes(':')) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return false;
    if (SEGMENT_FORBIDDEN.test(character)) return false;
  }
  return true;
}

function requireSegment(value: string, field: string): string {
  if (!isWorkspaceAgentConversationKeySegment(value)) {
    throw new Error(
      `${field} must be 1..${MAX_SEGMENT_LENGTH} characters without ':', control characters, or whitespace`,
    );
  }
  return value;
}

/** Deterministic conversation key for one (workspace, thread) outbound channel. */
export function buildWorkspaceAgentConversationKey(input: WorkspaceAgentConversationKeyInput): string {
  const workspaceId = requireSegment(input.workspaceId, 'workspaceId');
  const threadId = requireSegment(input.threadId, 'threadId');
  return `${KEY_PREFIX}:${workspaceId}:${threadId}`;
}

/**
 * Structural validation for values read back from config or telemetry.
 * Rebuilt on the same predicate as the builder: `clowder:<seg>:<seg>` where
 * both segments pass `isWorkspaceAgentConversationKeySegment` — guard and
 * builder cannot disagree by construction.
 */
export function isWorkspaceAgentConversationKey(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(`${KEY_PREFIX}:`)) return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  return (
    parts[0] === KEY_PREFIX &&
    isWorkspaceAgentConversationKeySegment(parts[1]) &&
    isWorkspaceAgentConversationKeySegment(parts[2])
  );
}
