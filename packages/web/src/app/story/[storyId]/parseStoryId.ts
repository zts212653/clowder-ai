/**
 * F252: Parse storyId from URL parameter.
 *
 * Next.js `useParams()` URL-encodes special characters in dynamic route segments,
 * so colons arrive as `%3A`. This function handles both raw and encoded forms.
 *
 * Phase A: `session:<sessionId>` → single session replay
 * Phase C: `feat:<featId>` → feature story (multi-thread swimlane)
 * Phase D: will add UUID-based persistent stories.
 */
export type ParsedStoryId = { type: 'session'; sessionId: string } | { type: 'feat'; featId: string };

/**
 * Decode a URL-encoded storyId parameter from Next.js useParams().
 * Shared by main story page (via parseStoryId) and public viewer page.
 * Handles %3A → : and gracefully falls back on malformed encoding.
 */
export function decodeStoryParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // Malformed percent-encoding — return as-is
  }
}

export function parseStoryId(raw: string): ParsedStoryId | null {
  const storyId = decodeStoryParam(raw);
  // Malformed encoding (e.g. "%ZZ") falls through as-is — won't match
  // any valid prefix below, so returns null. Behavior preserved.
  if (storyId.startsWith('session:')) {
    return { type: 'session', sessionId: storyId.slice('session:'.length) };
  }
  if (storyId.startsWith('feat:')) {
    const featId = storyId.slice('feat:'.length).toUpperCase();
    if (/^F\d{2,4}$/.test(featId)) {
      return { type: 'feat', featId };
    }
  }
  // Phase D: UUID-based persistent stories
  return null;
}
