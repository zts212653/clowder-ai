/**
 * F34: TTS Cache Cleaner
 *
 * Periodically cleans up stale audio files from data/tts-cache/.
 * - TTL: files older than 7 days are deleted
 * - LRU: if total size > 500MB, oldest files evicted until < 400MB
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createModuleLogger } from '../../../../infrastructure/logger.js';

const log = createModuleLogger('tts-cache');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
const TARGET_SIZE_BYTES = 400 * 1024 * 1024; // 400 MB (evict down to this)
const CLEAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CacheFileEntry {
  name: string;
  fullPath: string;
  mtimeMs: number;
  size: number;
}

/**
 * Run one cleanup pass on the TTS cache directory.
 */
export async function cleanTtsCache(cacheDir: string): Promise<{ deleted: number; freedBytes: number }> {
  let deleted = 0;
  let freedBytes = 0;

  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    // Directory doesn't exist yet — nothing to clean
    return { deleted: 0, freedBytes: 0 };
  }

  // Gather file stats
  const files: CacheFileEntry[] = [];
  for (const name of entries) {
    // Only touch audio files we created
    if (!name.endsWith('.wav') && !name.endsWith('.mp3')) continue;
    const fullPath = path.join(cacheDir, name);
    try {
      const s = await stat(fullPath);
      if (s.isFile()) {
        files.push({ name, fullPath, mtimeMs: s.mtimeMs, size: s.size });
      }
    } catch {
      // File may have been deleted by another process
    }
  }

  const now = Date.now();

  // Phase 1: TTL — delete files older than 7 days
  for (const file of files) {
    if (now - file.mtimeMs > SEVEN_DAYS_MS) {
      try {
        await unlink(file.fullPath);
        deleted++;
        freedBytes += file.size;
      } catch {
        // Ignore — file may have been deleted concurrently
      }
    }
  }

  // Recalculate remaining files
  const remaining = files.filter((f) => now - f.mtimeMs <= SEVEN_DAYS_MS);
  let totalSize = remaining.reduce((sum, f) => sum + f.size, 0);

  // Phase 2: LRU — if still over limit, evict oldest first
  if (totalSize > MAX_SIZE_BYTES) {
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const file of remaining) {
      if (totalSize <= TARGET_SIZE_BYTES) break;
      try {
        await unlink(file.fullPath);
        deleted++;
        freedBytes += file.size;
        totalSize -= file.size;
      } catch {
        // Ignore
      }
    }
  }

  return { deleted, freedBytes };
}

/**
 * Start periodic TTS cache cleanup.
 * Runs immediately, then every 6 hours.
 */
export function startTtsCacheCleaner(cacheDir: string): void {
  const runCleanup = async () => {
    try {
      const result = await cleanTtsCache(cacheDir);
      if (result.deleted > 0) {
        log.info({ deleted: result.deleted, freedMB: (result.freedBytes / 1024 / 1024).toFixed(1) }, 'Cache cleaned');
      }
    } catch (err) {
      log.error({ error: err }, 'Cleanup error');
    }
  };

  // Run immediately on startup
  void runCleanup();

  // Then every 6 hours
  setInterval(() => void runCleanup(), CLEAN_INTERVAL_MS);
}
