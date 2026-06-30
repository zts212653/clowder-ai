/**
 * F252 Phase D — StoryExportStore (AC-D2).
 *
 * File-based storage for sanitized export packs at
 * `<dataDir>/<sanitized-storyId>/exports/<exportId>/`.
 *
 * Each export contains:
 * - manifest.json — metadata + annotations
 * - events.json — sanitized event array
 *
 * Lifecycle (Stateful Object Gate):
 * - not-exists → create() → created (immutable)
 * - created → get() → served (read-only)
 * - created → delete() → deleted
 *
 * INV-4: Export pack immutable after creation (no update API)
 * INV-5: get returns null if export doesn't exist
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { StoryAnnotation } from '@cat-cafe/shared';
import {
  type CatIdentityAliases,
  type StoryExportPack,
  sanitizeStoryExport,
  type TranscriptEvent,
} from './content-sanitizer.js';

/**
 * Sanitize storyId for use as a directory name.
 * Whitelist approach: only allow alphanumeric, dash, underscore.
 * Everything else (including '/', '\', '.', ':') → '_'.
 * Prevents path traversal via encoded slashes (%2F → '/') or dot-dot.
 */
function sanitizeStoryId(storyId: string): string {
  return storyId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class StoryExportStore {
  constructor(private readonly dataDir: string) {}

  private exportsDir(storyId: string): string {
    return path.join(this.dataDir, sanitizeStoryId(storyId), 'exports');
  }

  private exportDir(storyId: string, exportId: string): string {
    // Sanitize exportId — user-controlled via URL params in get()/delete().
    // Same whitelist as storyId: prevents path traversal via '../'.
    // Server-generated exportIds (nanoid) only contain safe chars, so
    // sanitization is transparent for legitimate values.
    const safeExportId = exportId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.exportsDir(storyId), safeExportId);
  }

  /**
   * Create a sanitized export pack and persist it to disk.
   * Each call generates a new exportId (INV-4: no overwrite).
   */
  async create(
    storyId: string,
    title: string,
    events: TranscriptEvent[],
    annotations: StoryAnnotation[],
    catIdentityAliases?: CatIdentityAliases,
  ): Promise<StoryExportPack> {
    const pack = sanitizeStoryExport(storyId, title, events, annotations, catIdentityAliases);

    const dir = this.exportDir(storyId, pack.manifest.exportId);
    await fs.mkdir(dir, { recursive: true });

    await Promise.all([
      fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(pack.manifest, null, 2), 'utf-8'),
      fs.writeFile(path.join(dir, 'events.json'), JSON.stringify(pack.events, null, 2), 'utf-8'),
    ]);

    return pack;
  }

  /**
   * Retrieve an export pack by storyId + exportId.
   * Returns null if not found (INV-5).
   */
  async get(storyId: string, exportId: string): Promise<StoryExportPack | null> {
    const dir = this.exportDir(storyId, exportId);
    try {
      const [manifestRaw, eventsRaw] = await Promise.all([
        fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'),
        fs.readFile(path.join(dir, 'events.json'), 'utf-8'),
      ]);
      return {
        manifest: JSON.parse(manifestRaw),
        events: JSON.parse(eventsRaw),
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Get the most recent export for a storyId.
   * Compares by manifest.exportedAt timestamp.
   * Returns null if no exports exist.
   */
  async getLatest(storyId: string): Promise<StoryExportPack | null> {
    const exportsPath = this.exportsDir(storyId);
    let entries: string[];
    try {
      entries = await fs.readdir(exportsPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }

    if (entries.length === 0) return null;

    // Read all manifests and find the latest by exportedAt
    let latest: StoryExportPack | null = null;
    let latestTime = -1;

    for (const entry of entries) {
      const pack = await this.get(storyId, entry);
      if (pack && pack.manifest.exportedAt > latestTime) {
        latestTime = pack.manifest.exportedAt;
        latest = pack;
      }
    }

    return latest;
  }

  /** Delete an export pack. Idempotent — no error if not found. */
  async delete(storyId: string, exportId: string): Promise<void> {
    const dir = this.exportDir(storyId, exportId);
    await fs.rm(dir, { recursive: true, force: true });
  }
}
