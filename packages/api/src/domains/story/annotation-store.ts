/**
 * F252 Phase D — AnnotationFileStore (AC-D1).
 *
 * File-based annotation persistence: one JSON file per storyId at
 * `<dataDir>/<sanitized-storyId>/annotations.json`.
 *
 * Lifecycle (Stateful Object Gate):
 * - not-exists → add() → created (v=1)
 * - created (v=N) → add/update/remove → updated (v=N+1)
 *
 * Invariants:
 * - INV-1: annotation.id unique within set (nanoid generation)
 * - INV-2: version monotonically increases on every write
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AnnotationSet, StoryAnnotation } from '@cat-cafe/shared';
import { nanoid } from 'nanoid';

// ============================================================================
// Input types for add/update
// ============================================================================

export interface AddAnnotationInput {
  at: number;
  kind: 'narration' | 'highlight';
  content: string;
}

export interface UpdateAnnotationInput {
  at?: number;
  kind?: 'narration' | 'highlight';
  content?: string;
}

// ============================================================================
// Custom errors
// ============================================================================

export class AnnotationNotFoundError extends Error {
  constructor(annotationId: string) {
    super(`Annotation not found: ${annotationId}`);
    this.name = 'AnnotationNotFoundError';
  }
}

export class VersionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Version conflict: expected ${expected}, actual ${actual}`);
    this.name = 'VersionConflictError';
  }
}

// ============================================================================
// Store implementation
// ============================================================================

/**
 * Sanitize storyId for use as a directory name.
 * Whitelist approach: only allow alphanumeric, dash, underscore.
 * Everything else (including '/', '\', '.', ':') → '_'.
 * Prevents path traversal via encoded slashes (%2F → '/') or dot-dot.
 *
 * `feat:F252` → `feat_F252`, `session:abc-123` → `session_abc-123`
 * `session:/../../tmp/pwn` → `session____tmp_pwn` (safe)
 */
function sanitizeStoryId(storyId: string): string {
  return storyId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class AnnotationFileStore {
  /**
   * Per-storyId write serialization (P1-4 fix).
   * Prevents TOCTOU race: concurrent read-check-write cycles
   * are serialized per storyId so no writes are lost.
   */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: string) {}

  /**
   * Serialize write operations per storyId using promise chaining.
   * Each caller waits for the previous operation on the same storyId
   * to complete before starting its read-check-write cycle.
   */
  private async withLock<T>(storyId: string, fn: () => Promise<T>): Promise<T> {
    const key = sanitizeStoryId(storyId);
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, next);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      // Clean up map entry if no one else queued after us
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }

  private filePath(storyId: string): string {
    return path.join(this.dataDir, sanitizeStoryId(storyId), 'annotations.json');
  }

  /** Read the annotation set from disk. Returns empty set if file doesn't exist. */
  async get(storyId: string): Promise<AnnotationSet> {
    const fp = this.filePath(storyId);
    try {
      const raw = await fs.readFile(fp, 'utf-8');
      return JSON.parse(raw) as AnnotationSet;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { storyId, annotations: [], version: 0 };
      }
      throw err;
    }
  }

  /** Add a new annotation to the set. Returns the created annotation. */
  async add(storyId: string, input: AddAnnotationInput): Promise<StoryAnnotation> {
    return this.withLock(storyId, async () => {
      const set = await this.get(storyId);

      const now = Date.now();
      const annotation: StoryAnnotation = {
        id: nanoid(),
        storyId,
        at: input.at,
        kind: input.kind,
        content: input.content,
        createdAt: now,
        updatedAt: now,
      };

      set.annotations.push(annotation);
      set.version += 1;
      set.storyId = storyId;

      await this.write(storyId, set);
      return annotation;
    });
  }

  /**
   * Update an existing annotation.
   * @param expectedVersion If provided, rejects with VersionConflictError if stale.
   */
  async update(
    storyId: string,
    annotationId: string,
    input: UpdateAnnotationInput,
    expectedVersion?: number,
  ): Promise<StoryAnnotation> {
    return this.withLock(storyId, async () => {
      const set = await this.get(storyId);

      if (expectedVersion !== undefined && expectedVersion !== set.version) {
        throw new VersionConflictError(expectedVersion, set.version);
      }

      const idx = set.annotations.findIndex((a) => a.id === annotationId);
      if (idx === -1) {
        throw new AnnotationNotFoundError(annotationId);
      }

      // idx validated by findIndex + throw above — safe access
      const existing = set.annotations[idx] as StoryAnnotation;
      const updated: StoryAnnotation = {
        ...existing,
        ...(input.at !== undefined && { at: input.at }),
        ...(input.kind !== undefined && { kind: input.kind }),
        ...(input.content !== undefined && { content: input.content }),
        updatedAt: Date.now(),
      };

      set.annotations[idx] = updated;
      set.version += 1;

      await this.write(storyId, set);
      return updated;
    });
  }

  /** Remove an annotation by id. */
  async remove(storyId: string, annotationId: string): Promise<void> {
    return this.withLock(storyId, async () => {
      const set = await this.get(storyId);

      const idx = set.annotations.findIndex((a) => a.id === annotationId);
      if (idx === -1) {
        throw new AnnotationNotFoundError(annotationId);
      }

      set.annotations.splice(idx, 1);
      set.version += 1;

      await this.write(storyId, set);
    });
  }

  /** Write the annotation set to disk, creating directories as needed. */
  private async write(storyId: string, set: AnnotationSet): Promise<void> {
    const fp = this.filePath(storyId);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, JSON.stringify(set, null, 2), 'utf-8');
  }
}
