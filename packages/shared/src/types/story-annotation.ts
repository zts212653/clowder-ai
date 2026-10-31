/**
 * F252 Phase D — Story Annotation types (AC-D1).
 *
 * Annotations attach user narration / highlight markers at arbitrary
 * timestamps within a story replay.  Storage: `data/stories/:storyId/annotations.json`.
 */

// ============================================================================
// Annotation
// ============================================================================

/**
 * A single annotation pinned to a story timeline.
 *
 * `kind`:
 * - `narration` — free-form text narration (displayed as floating card)
 * - `highlight` — visual emphasis marker (pulsing dot on the timeline)
 */
export interface StoryAnnotation {
  id: string;
  storyId: string;
  /** Timestamp this annotation is pinned to (Unix ms). */
  at: number;
  kind: 'narration' | 'highlight';
  /** Markdown text content. */
  content: string;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Annotation Set (per-story collection with optimistic concurrency)
// ============================================================================

/**
 * The full annotation collection for a single story.
 *
 * Lifecycle (Stateful Object Gate):
 * - not-exists → POST → created (v=1)
 * - created (v=N) → PUT/DELETE/POST → updated (v=N+1)
 *
 * INV-1: annotation.id unique within set
 * INV-2: version monotonically increases on write
 * INV-3: annotation.at must be within story time range (caller-enforced)
 */
export interface AnnotationSet {
  storyId: string;
  annotations: StoryAnnotation[];
  /** Optimistic concurrency token — bumped on every write. */
  version: number;
}
