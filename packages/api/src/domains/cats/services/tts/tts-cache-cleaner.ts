/**
 * F34: TTS Cache Cleaner
 *
 * Periodically cleans up stale audio files from the configured TTS cache.
 * - TTL: files older than 7 days are deleted
 * - LRU: if total size > 500MB, oldest files evicted until < 400MB
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import type { DocumentListenRepository, ListenAssetPolicy } from './DocumentListenRepository.js';

const log = createModuleLogger('tts-cache');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
const TARGET_SIZE_BYTES = 400 * 1024 * 1024; // 400 MB (evict down to this)
const CLEAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface TtsCacheCleanupLimits {
  maxSizeBytes?: number;
  targetSizeBytes?: number;
}

interface CacheFileEntry {
  name: string;
  fullPath: string;
  mtimeMs: number;
  size: number;
}

interface CleanupResult {
  deleted: number;
  freedBytes: number;
}

async function listCacheAudio(cacheDir: string): Promise<CacheFileEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return [];
  }
  const files: CacheFileEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith('.wav') && !name.endsWith('.mp3')) continue;
    const fullPath = path.join(cacheDir, name);
    try {
      const fileStat = await stat(fullPath);
      if (fileStat.isFile()) files.push({ name, fullPath, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
    } catch {
      // File may have been deleted by another process.
    }
  }
  return files;
}

async function deleteCacheFile(
  file: CacheFileEntry,
  documentListenRepository: DocumentListenRepository,
): Promise<CleanupResult> {
  try {
    await unlink(file.fullPath);
    documentListenRepository.forgetAsset(file.name);
    return { deleted: 1, freedBytes: file.size };
  } catch {
    return { deleted: 0, freedBytes: 0 };
  }
}

function addCleanupResult(total: CleanupResult, next: CleanupResult): void {
  total.deleted += next.deleted;
  total.freedBytes += next.freedBytes;
}

/**
 * Run one cleanup pass on the TTS cache directory.
 */
export async function cleanTtsCache(
  cacheDir: string,
  documentListenRepository: DocumentListenRepository | undefined,
  now = Date.now(),
  limits: TtsCacheCleanupLimits = {},
): Promise<{ deleted: number; freedBytes: number }> {
  if (!documentListenRepository) throw new Error('Document listen repository is required for cache cleanup');
  const maxSizeBytes = limits.maxSizeBytes ?? MAX_SIZE_BYTES;
  const targetSizeBytes = limits.targetSizeBytes ?? TARGET_SIZE_BYTES;
  const result: CleanupResult = { deleted: 0, freedBytes: 0 };
  const files = await listCacheAudio(cacheDir);
  const policies = new Map(documentListenRepository.listAssetPolicies().map((policy) => [policy.assetId, policy]));
  const removed = new Set<string>();

  // Phase 1: F279 assets follow manifest retention/last-use. Legacy assets keep the 7d mtime contract.
  for (const file of files) {
    const policy = policies.get(file.name);
    const expired = policy ? policy.expiresAt != null && now > policy.expiresAt : now - file.mtimeMs > SEVEN_DAYS_MS;
    if (expired) {
      const deleted = await deleteCacheFile(file, documentListenRepository);
      if (deleted.deleted > 0) removed.add(file.name);
      addCleanupResult(result, deleted);
    }
  }

  // Recalculate remaining files
  const remaining = files.filter((file) => !removed.has(file.name));
  let totalSize = remaining.reduce((sum, f) => sum + f.size, 0);

  // Phase 2: LRU — if still over limit, evict oldest first
  if (totalSize > maxSizeBytes) {
    remaining.sort((left, right) => lastUsedAt(left, policies) - lastUsedAt(right, policies));
    for (const file of remaining) {
      if (totalSize <= targetSizeBytes) break;
      // A manifest retention is an availability promise. Size pressure may
      // evict legacy cache entries, never a live 7d/30d/forever listen asset.
      if (policies.has(file.name)) continue;
      const deleted = await deleteCacheFile(file, documentListenRepository);
      addCleanupResult(result, deleted);
      totalSize -= deleted.freedBytes;
    }
  }

  return result;
}

function lastUsedAt(file: CacheFileEntry, policies: Map<string, ListenAssetPolicy>): number {
  return policies.get(file.name)?.lastUsedAt ?? file.mtimeMs;
}

/**
 * Start periodic TTS cache cleanup.
 * Runs immediately, then every 6 hours.
 */
export function startTtsCacheCleaner(cacheDir: string, documentListenRepository: DocumentListenRepository): void {
  const runCleanup = async () => {
    try {
      const result = await cleanTtsCache(cacheDir, documentListenRepository);
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
