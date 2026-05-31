/**
 * Codex Session Context Snapshot Resolver
 *
 * Reads Codex local session rollout files under ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
 * and extracts the latest token_count event for a given session ID.
 *
 * token_count payload provides the context metrics shown by Codex UI, including:
 * - last_token_usage.input_tokens (current context used)
 * - model_context_window (window size)
 * - rate_limits.*.resets_at (limit reset timestamp)
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TAIL_BYTES = 256 * 1024;
const DEFAULT_FILE_CACHE_MAX = 100;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface CodexSessionContextSnapshot {
  /** Latest context usage shown by Codex session status */
  contextUsedTokens: number;
  /** Model context window capacity */
  contextWindowTokens: number;
  /** Optional reset timestamp in epoch milliseconds */
  contextResetsAtMs?: number;
  /** Optional last-token usage counters from the same token_count payload */
  lastCachedInputTokens?: number;
  lastOutputTokens?: number;
  /** Optional total usage counters from the same token_count payload */
  totalInputTokens?: number;
  totalCachedInputTokens?: number;
  totalOutputTokens?: number;
}

export type CodexSessionContextSnapshotResolver = (sessionId: string) => Promise<CodexSessionContextSnapshot | null>;

interface CandidateSnapshot {
  snapshot: CodexSessionContextSnapshot;
  hasNonZeroRateUsage: boolean;
}

function toCandidateSnapshot(payload: Record<string, unknown>): CandidateSnapshot | null {
  if (payload.type !== 'token_count') return null;

  const info = asRecord(payload.info);
  if (!info) return null;

  const lastUsage = asRecord(info.last_token_usage);
  const contextUsedTokens = asNumber(lastUsage?.input_tokens);
  const contextWindowTokens = asNumber(info.model_context_window);
  if (contextUsedTokens == null || contextWindowTokens == null) return null;

  const totalUsage = asRecord(info.total_token_usage);

  const rateLimits = asRecord(payload.rate_limits);
  const primary = asRecord(rateLimits?.primary);
  const secondary = asRecord(rateLimits?.secondary);
  const primaryUsed = asNumber(primary?.used_percent);
  const secondaryUsed = asNumber(secondary?.used_percent);
  const hasNonZeroRateUsage = (primaryUsed ?? 0) > 0 || (secondaryUsed ?? 0) > 0;
  const resetsAtSeconds = asNumber(secondary?.resets_at) ?? asNumber(primary?.resets_at);
  const lastCachedInputTokens = asNumber(lastUsage?.cached_input_tokens);
  const lastOutputTokens = asNumber(lastUsage?.output_tokens);
  const totalInputTokens = asNumber(totalUsage?.input_tokens);
  const totalCachedInputTokens = asNumber(totalUsage?.cached_input_tokens);
  const totalOutputTokens = asNumber(totalUsage?.output_tokens);

  const snapshot: CodexSessionContextSnapshot = { contextUsedTokens, contextWindowTokens };
  if (resetsAtSeconds != null) {
    snapshot.contextResetsAtMs = Math.trunc(resetsAtSeconds * 1000);
  }
  if (lastCachedInputTokens != null) {
    snapshot.lastCachedInputTokens = lastCachedInputTokens;
  }
  if (lastOutputTokens != null) {
    snapshot.lastOutputTokens = lastOutputTokens;
  }
  if (totalInputTokens != null) {
    snapshot.totalInputTokens = totalInputTokens;
  }
  if (totalCachedInputTokens != null) {
    snapshot.totalCachedInputTokens = totalCachedInputTokens;
  }
  if (totalOutputTokens != null) {
    snapshot.totalOutputTokens = totalOutputTokens;
  }

  return { snapshot, hasNonZeroRateUsage };
}

async function readTailUtf8(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const readBytes = Math.min(stat.size, maxBytes);
    if (readBytes <= 0) return '';

    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, stat.size - readBytes);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

interface ResolverOptions {
  sessionsRoot?: string;
  tailBytes?: number;
  fileCache?: Map<string, string>;
  maxCacheEntries?: number;
}

/**
 * Creates a best-effort resolver for Codex context snapshot by session ID.
 * Resolver is resilient: returns null when files are missing/unreadable.
 */
export function createCodexSessionContextSnapshotResolver(
  options?: ResolverOptions,
): CodexSessionContextSnapshotResolver {
  const sessionsRoot = options?.sessionsRoot ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  const tailBytes = options?.tailBytes ?? DEFAULT_TAIL_BYTES;
  const maxCacheEntries = Math.max(1, options?.maxCacheEntries ?? DEFAULT_FILE_CACHE_MAX);
  const fileCache = options?.fileCache ?? new Map<string, string>();

  function upsertCache(sessionId: string, filePath: string): void {
    if (fileCache.has(sessionId)) {
      fileCache.delete(sessionId);
    }
    fileCache.set(sessionId, filePath);
    while (fileCache.size > maxCacheEntries) {
      const oldestKey = fileCache.keys().next().value;
      if (!oldestKey) break;
      fileCache.delete(oldestKey);
    }
  }

  async function findSessionFile(sessionId: string): Promise<string | null> {
    const cached = fileCache.get(sessionId);
    if (cached) {
      try {
        await fs.access(cached);
        upsertCache(sessionId, cached);
        return cached;
      } catch {
        fileCache.delete(sessionId);
      }
    }

    const stack: string[] = [sessionsRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) break;

      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) {
          upsertCache(sessionId, abs);
          return abs;
        }
      }
    }

    return null;
  }

  return async (sessionId: string): Promise<CodexSessionContextSnapshot | null> => {
    if (!sessionId) return null;

    const file = await findSessionFile(sessionId);
    if (!file) return null;

    const tail = await readTailUtf8(file, tailBytes);
    if (!tail) return null;

    const lines = tail.split('\n');
    let fallback: CodexSessionContextSnapshot | null = null;

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim();
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const row = asRecord(parsed);
      const payload = asRecord(row?.payload);
      if (!payload) continue;

      const candidate = toCandidateSnapshot(payload);
      if (!candidate) continue;
      if (candidate.hasNonZeroRateUsage) return candidate.snapshot;
      if (!fallback) fallback = candidate.snapshot;
    }

    return fallback;
  };
}
