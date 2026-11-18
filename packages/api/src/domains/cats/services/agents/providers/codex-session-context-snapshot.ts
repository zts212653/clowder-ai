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
const TURN_CLOSING_EVENT_TYPES = new Set(['task_complete', 'turn_aborted', 'task_aborted']);
const TURN_SCOPED_EVENT_TYPES = new Set(['task_started', 'item_started', 'item_completed']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface CodexSessionRateLimitWindow {
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  readonly resetsAtSeconds?: number;
}

export interface CodexSessionRateLimitsSnapshot {
  readonly limitId: string;
  readonly observedAtMs?: number;
  readonly primary?: CodexSessionRateLimitWindow;
  readonly secondary?: CodexSessionRateLimitWindow;
}

export interface CodexAdmittedTurnQuotaWindow {
  readonly sessionId: string;
  readonly turnId: string;
  readonly startByteOffset: number;
  readonly endByteOffset: number;
  readonly startMs: number;
  readonly endMs: number;
}

export interface CodexSessionContextSnapshot {
  /** Latest context usage shown by Codex session status */
  contextUsedTokens: number;
  /** Model context window capacity */
  contextWindowTokens: number;
  /** Optional reset timestamp in epoch milliseconds */
  contextResetsAtMs?: number;
  /** Latest rate limit windows observed within the admitted turn provenance boundary */
  rateLimits?: CodexSessionRateLimitsSnapshot;
  /** Optional last-token usage counters from the same token_count payload */
  lastCachedInputTokens?: number;
  lastOutputTokens?: number;
  /** Optional total usage counters from the same token_count payload */
  totalInputTokens?: number;
  totalCachedInputTokens?: number;
  totalOutputTokens?: number;
}

export interface CodexSessionContextSnapshotResolveOptions {
  /**
   * Admitted turn windows proved on this invocation's private RPC/stdout channel.
   * When provided, an empty list strictly yields `rateLimits: undefined` and never falls back to unscoped rollout lines.
   */
  readonly rateLimitsTurnWindows?: readonly CodexAdmittedTurnQuotaWindow[];
}

export type CodexSessionContextSnapshotResolver = (
  sessionId: string,
  selectedSessionsRoot?: string,
  options?: CodexSessionContextSnapshotResolveOptions,
) => Promise<CodexSessionContextSnapshot | null>;

interface CandidateSnapshot {
  snapshot: CodexSessionContextSnapshot;
  hasNonZeroRateUsage: boolean;
}

interface TailBufferSlice {
  readonly buffer: Buffer;
  readonly startByteOffset: number;
}

interface ParsedRolloutLine {
  readonly lineByteStart: number;
  readonly lineByteEnd: number;
  readonly rowType: string | undefined;
  readonly payload: Record<string, unknown>;
  readonly timestamp: unknown;
}

interface RateLimitCandidate {
  readonly lineByteStart: number;
  readonly lineByteEnd: number;
  readonly enclosingTurnId: string | null;
  readonly rateLimits: CodexSessionRateLimitsSnapshot;
}

function parseRateWindow(raw: Record<string, unknown> | null): CodexSessionRateLimitWindow | undefined {
  const used = asNumber(raw?.used_percent);
  if (used == null || used < 0 || used > 100) return undefined;
  const windowMinutes = asNumber(raw?.window_minutes);
  const resetsAtSeconds = asNumber(raw?.resets_at);
  return {
    usedPercent: used,
    ...(windowMinutes != null && windowMinutes > 0 ? { windowMinutes } : {}),
    ...(resetsAtSeconds != null && resetsAtSeconds >= 0 ? { resetsAtSeconds } : {}),
  };
}

function parseRateLimitsSnapshot(
  payload: Record<string, unknown>,
  rowTimestamp?: unknown,
): CodexSessionRateLimitsSnapshot | undefined {
  if (payload.type !== 'token_count') return undefined;
  const rateLimits = asRecord(payload.rate_limits);
  const primaryWindow = parseRateWindow(asRecord(rateLimits?.primary));
  const secondaryWindow = parseRateWindow(asRecord(rateLimits?.secondary));
  if (!primaryWindow && !secondaryWindow) return undefined;
  const limitId =
    typeof rateLimits?.limit_id === 'string' && rateLimits.limit_id.trim() ? rateLimits.limit_id.trim() : 'codex';
  const parsedTime = typeof rowTimestamp === 'string' ? Date.parse(rowTimestamp) : Number.NaN;
  return {
    limitId,
    ...(Number.isFinite(parsedTime) && parsedTime >= 0 ? { observedAtMs: parsedTime } : {}),
    ...(primaryWindow ? { primary: primaryWindow } : {}),
    ...(secondaryWindow ? { secondary: secondaryWindow } : {}),
  };
}

function toCandidateSnapshot(payload: Record<string, unknown>, rowTimestamp?: unknown): CandidateSnapshot | null {
  if (payload.type !== 'token_count') return null;

  const info = asRecord(payload.info);
  if (!info) return null;

  const lastUsage = asRecord(info.last_token_usage);
  const contextUsedTokens = asNumber(lastUsage?.input_tokens);
  const contextWindowTokens = asNumber(info.model_context_window);
  if (contextUsedTokens == null || contextWindowTokens == null) return null;

  const totalUsage = asRecord(info.total_token_usage);
  const rateLimits = parseRateLimitsSnapshot(payload, rowTimestamp);
  const hasNonZeroRateUsage =
    (rateLimits?.primary?.usedPercent ?? 0) > 0 || (rateLimits?.secondary?.usedPercent ?? 0) > 0;
  const resetsAtSeconds = rateLimits?.secondary?.resetsAtSeconds ?? rateLimits?.primary?.resetsAtSeconds;
  const lastCachedInputTokens = asNumber(lastUsage?.cached_input_tokens);
  const lastOutputTokens = asNumber(lastUsage?.output_tokens);
  const totalInputTokens = asNumber(totalUsage?.input_tokens);
  const totalCachedInputTokens = asNumber(totalUsage?.cached_input_tokens);
  const totalOutputTokens = asNumber(totalUsage?.output_tokens);

  const snapshot: CodexSessionContextSnapshot = { contextUsedTokens, contextWindowTokens };
  if (resetsAtSeconds != null) snapshot.contextResetsAtMs = Math.trunc(resetsAtSeconds * 1000);
  if (lastCachedInputTokens != null) snapshot.lastCachedInputTokens = lastCachedInputTokens;
  if (lastOutputTokens != null) snapshot.lastOutputTokens = lastOutputTokens;
  if (totalInputTokens != null) snapshot.totalInputTokens = totalInputTokens;
  if (totalCachedInputTokens != null) snapshot.totalCachedInputTokens = totalCachedInputTokens;
  if (totalOutputTokens != null) snapshot.totalOutputTokens = totalOutputTokens;

  return { snapshot, hasNonZeroRateUsage };
}

async function readTailBufferSlice(filePath: string, maxBytes: number): Promise<TailBufferSlice | null> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size <= 0) return null;

    const readBytes = Math.min(stat.size, maxBytes);
    const position = stat.size - readBytes;
    const raw = Buffer.alloc(readBytes);
    await handle.read(raw, 0, readBytes, position);

    if (position > 0) {
      const firstNewline = raw.indexOf(0x0a);
      if (firstNewline < 0) return null;
      return { buffer: raw.subarray(firstNewline + 1), startByteOffset: position + firstNewline + 1 };
    }
    return { buffer: raw, startByteOffset: 0 };
  } finally {
    await handle.close();
  }
}

function parseRolloutRecordLine(
  lineText: string,
  lineByteStart: number,
  lineByteEnd: number,
): ParsedRolloutLine | null {
  if (!lineText) return null;
  try {
    const row = asRecord(JSON.parse(lineText));
    const payload = asRecord(row?.payload);
    if (!payload) return null;
    return {
      lineByteStart,
      lineByteEnd,
      rowType: typeof row?.type === 'string' ? row.type : undefined,
      payload,
      timestamp: row?.timestamp,
    };
  } catch {
    return null;
  }
}

function parseTailLines(slice: TailBufferSlice): ParsedRolloutLine[] {
  const out: ParsedRolloutLine[] = [];
  let cursor = 0;
  while (cursor < slice.buffer.length) {
    const newlineIdx = slice.buffer.indexOf(0x0a, cursor);
    const lineEndIdx = newlineIdx >= 0 ? newlineIdx : slice.buffer.length;
    const nextCursor = newlineIdx >= 0 ? newlineIdx + 1 : slice.buffer.length;
    const lineText = slice.buffer.subarray(cursor, lineEndIdx).toString('utf8').trim();
    const parsed = parseRolloutRecordLine(lineText, slice.startByteOffset + cursor, slice.startByteOffset + nextCursor);
    if (parsed) out.push(parsed);
    cursor = nextCursor;
  }
  return out;
}

function selectContextSnapshot(rows: readonly ParsedRolloutLine[]): CodexSessionContextSnapshot | null {
  let fallbackContext: CodexSessionContextSnapshot | null = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const candidate = row ? toCandidateSnapshot(row.payload, row.timestamp) : null;
    if (!candidate) continue;
    if (candidate.hasNonZeroRateUsage) return candidate.snapshot;
    if (!fallbackContext) fallbackContext = candidate.snapshot;
  }
  return fallbackContext;
}

function extractSpanTurnId(row: ParsedRolloutLine): string | null {
  const turnId = typeof row.payload.turn_id === 'string' && row.payload.turn_id ? row.payload.turn_id : null;
  if (!turnId) return null;
  if (row.rowType === 'turn_context' || row.rowType === 'token_usage_record') return turnId;
  if (row.rowType === 'event_msg' && TURN_SCOPED_EVENT_TYPES.has(String(row.payload.type))) return turnId;
  return null;
}

function isTurnClosingRow(row: ParsedRolloutLine, activeTurnId: string | null): boolean {
  if (row.rowType !== 'event_msg' || !TURN_CLOSING_EVENT_TYPES.has(String(row.payload.type))) return false;
  const closedTurnId = typeof row.payload.turn_id === 'string' ? row.payload.turn_id : null;
  return !closedTurnId || closedTurnId === activeTurnId;
}

function collectRateLimitCandidates(rows: readonly ParsedRolloutLine[]): RateLimitCandidate[] {
  const candidates: RateLimitCandidate[] = [];
  let activeTurnId: string | null = null;

  for (const row of rows) {
    const spanTurnId = extractSpanTurnId(row);
    if (spanTurnId) activeTurnId = spanTurnId;
    const rateLimits = parseRateLimitsSnapshot(row.payload, row.timestamp);
    if (rateLimits) {
      const explicitTurnId =
        typeof row.payload.turn_id === 'string' && row.payload.turn_id ? row.payload.turn_id : null;
      candidates.push({
        lineByteStart: row.lineByteStart,
        lineByteEnd: row.lineByteEnd,
        enclosingTurnId: explicitTurnId ?? activeTurnId,
        rateLimits,
      });
    }
    if (isTurnClosingRow(row, activeTurnId)) {
      activeTurnId = null;
    }
  }
  return candidates;
}

function matchesAdmittedWindow(cand: RateLimitCandidate, win: CodexAdmittedTurnQuotaWindow): boolean {
  if (!win.turnId || !cand.enclosingTurnId || cand.enclosingTurnId !== win.turnId) return false;
  const ts = cand.rateLimits.observedAtMs;
  if (ts === undefined || ts < win.startMs || ts > win.endMs) return false;
  return cand.lineByteStart >= win.startByteOffset && cand.lineByteEnd <= win.endByteOffset;
}

/** Select the latest rate_limits strictly proved to belong to an admitted turn; never skips 0% usage or fails open on missing turn IDs. */
function selectTurnScopedRateLimits(
  rows: readonly ParsedRolloutLine[],
  windows: readonly CodexAdmittedTurnQuotaWindow[] | undefined,
): CodexSessionRateLimitsSnapshot | undefined {
  if (!windows || windows.length === 0) return undefined;
  const candidates = collectRateLimitCandidates(rows);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const cand = candidates[i];
    if (cand && windows.some((win) => matchesAdmittedWindow(cand, win))) {
      return cand.rateLimits;
    }
  }
  return undefined;
}

async function locateRolloutFile(sessionId: string, selectedRoot: string): Promise<string | null> {
  const stack: string[] = [selectedRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;

    let entries: import('node:fs').Dirent[];
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
        return abs;
      }
    }
  }
  return null;
}

/** Measure existing rollout byte length at turn boundaries so outside bytes cannot contaminate quota. */
export async function measureCodexSessionRolloutSize(sessionId: string, selectedSessionsRoot: string): Promise<number> {
  if (!sessionId || !selectedSessionsRoot) return 0;
  try {
    const file = await locateRolloutFile(sessionId, selectedSessionsRoot);
    if (!file) return 0;
    const stat = await fs.stat(file);
    return stat.size;
  } catch {
    return 0;
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

  async function findSessionFile(sessionId: string, selectedRoot: string): Promise<string | null> {
    const cacheKey = selectedRoot === sessionsRoot ? sessionId : `${selectedRoot}\0${sessionId}`;
    const cached = fileCache.get(cacheKey);
    if (cached) {
      try {
        await fs.access(cached);
        upsertCache(cacheKey, cached);
        return cached;
      } catch {
        fileCache.delete(cacheKey);
      }
    }

    const found = await locateRolloutFile(sessionId, selectedRoot);
    if (found) upsertCache(cacheKey, found);
    return found;
  }

  return async (
    sessionId: string,
    selectedSessionsRoot = sessionsRoot,
    resolveOptions?: CodexSessionContextSnapshotResolveOptions,
  ): Promise<CodexSessionContextSnapshot | null> => {
    if (!sessionId) return null;

    const file = await findSessionFile(sessionId, selectedSessionsRoot);
    if (!file) return null;

    const tailSlice = await readTailBufferSlice(file, tailBytes);
    const rows = tailSlice ? parseTailLines(tailSlice) : [];
    const baseSnapshot = rows.length > 0 ? selectContextSnapshot(rows) : null;
    if (!baseSnapshot) return null;

    const rateLimits = selectTurnScopedRateLimits(rows, resolveOptions?.rateLimitsTurnWindows);
    return rateLimits ? { ...baseSnapshot, rateLimits } : baseSnapshot;
  };
}
