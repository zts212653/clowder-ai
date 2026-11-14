import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { sanitizeCliStderr } from '../../../../../../../utils/sanitize-cli-stderr.js';

/**
 * Kimi Code's ACP bridge settles every non-auth provider failure as a clean
 * `end_turn` (see `turnEndReasonToStopReason` in its dist): only auth errors
 * reach the JSON-RPC error channel. The real cause survives solely in the
 * CLI's own per-session turn ledger, so the Host reads that bounded evidence
 * instead of guessing from an empty stream.
 *
 * Scope: one exact session, only records appended after the prompt's boundary,
 * from a bounded window. Missing or unreadable evidence returns `unknown` — the
 * caller keeps its existing honest message.
 */
export interface KimiTurnFailure {
  readonly code?: string;
  readonly name?: string;
  readonly statusCode?: number;
  readonly message: string;
}

export type KimiTurnOutcome =
  | { readonly kind: 'failed'; readonly failure: KimiTurnFailure }
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unknown' };

const TAIL_BYTES = 256 * 1024;
const MESSAGE_LIMIT = 320;
const FIELD_LIMIT = 120;
const TURN_LEDGER = join('agents', 'main', 'wire.jsonl');

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boundedText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  // Sanitize before truncating so a cut token cannot slip through the redactor.
  return sanitizeCliStderr(value)
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function toFailure(value: unknown): KimiTurnFailure {
  const error = record(value);
  const details = record(error.details);
  const statusCode = typeof details.statusCode === 'number' ? details.statusCode : undefined;
  const code = boundedText(error.code, FIELD_LIMIT);
  const name = boundedText(error.name, FIELD_LIMIT);
  return Object.freeze({
    ...(code ? { code } : {}),
    ...(name ? { name } : {}),
    ...(statusCode === undefined ? {} : { statusCode }),
    message: boundedText(error.message, MESSAGE_LIMIT),
  });
}

/** Kimi keys sessions by `<basename>_<sha256(cwd) prefix>`; keep this the sole path authority. */
export function kimiSessionTurnLedgerPath(input: {
  readonly shareDir: string;
  readonly cwd: string;
  readonly sessionId: string;
}): string {
  const project = resolve(input.cwd);
  const workspace = `wd_${basename(project)}_${createHash('sha256').update(project).digest('hex').slice(0, 12)}`;
  const session = input.sessionId.replace(/^session_/, '');
  return join(input.shareDir, 'sessions', workspace, `session_${session}`, TURN_LEDGER);
}

/**
 * Resolve the native home from the exact child environment only. An absent key
 * must never fall back to ambient host state: another account's KIMI_CODE_HOME
 * would silently attribute that account's ledger to this turn.
 */
export function resolveKimiShareDir(env: Readonly<Record<string, string | undefined>>): string | null {
  const explicit = env.KIMI_CODE_HOME?.trim();
  if (explicit) return explicit;
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  return home ? join(home, '.kimi-code') : null;
}

/** Append position captured before a prompt; only bytes after it may explain that prompt. */
export interface KimiLedgerBoundary {
  readonly size: number;
}

export async function captureKimiLedgerBoundary(input: {
  readonly shareDir: string;
  readonly cwd: string;
  readonly sessionId: string;
}): Promise<KimiLedgerBoundary | null> {
  try {
    const info = await stat(kimiSessionTurnLedgerPath(input));
    if (!info.isFile()) return null;
    return { size: info.size };
  } catch (error) {
    // No ledger yet is a valid zero boundary; any other failure stays unknown.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { size: 0 } : null;
  }
}

async function readRange(path: string, start: number, end: number): Promise<string | null> {
  const length = end - start;
  if (length <= 0) return null;
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Newest terminal record in the appended window; earlier turn boundaries never qualify. */
function lastTurnEnded(lines: readonly string[]): Record<string, unknown> | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = record(parsed);
    if (entry.type === 'turn.ended') return entry;
  }
  return null;
}

/**
 * Read only what was appended after the pre-prompt boundary. A terminal that
 * predates the boundary cannot describe this turn; a shrunken or missing ledger
 * proves nothing and stays `unknown`.
 */
export async function readKimiTurnOutcome(input: {
  readonly shareDir: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly boundary: KimiLedgerBoundary;
}): Promise<KimiTurnOutcome> {
  const path = kimiSessionTurnLedgerPath(input);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return { kind: 'unknown' };
  }
  if (!info.isFile() || info.size < input.boundary.size) return { kind: 'unknown' };
  if (info.size === input.boundary.size) return { kind: 'unknown' };
  const start = Math.max(input.boundary.size, info.size - TAIL_BYTES);
  const chunk = await readRange(path, start, info.size);
  if (chunk === null) return { kind: 'unknown' };
  const lines = chunk.split('\n');
  // A capped window may start mid-line; only then drop the partial fragment.
  if (start > input.boundary.size) lines.shift();
  const entry = lastTurnEnded(lines);
  if (!entry) return { kind: 'unknown' };
  if (entry.reason === 'completed') return { kind: 'completed' };
  if (entry.reason === 'cancelled') return { kind: 'cancelled' };
  if (entry.reason !== 'failed') return { kind: 'unknown' };
  return { kind: 'failed', failure: toFailure(entry.error) };
}

/** Render only the fields a reader needs; never the transcript, ids or credentials. */
export function formatKimiTurnFailure(failure: KimiTurnFailure): string {
  const meta = [failure.name, failure.statusCode === undefined ? undefined : `HTTP ${failure.statusCode}`, failure.code]
    .filter((part): part is string => Boolean(part))
    .join(' / ');
  const body = failure.message || '上游本轮终态为失败，未提供错误文本';
  return meta ? `${body}（${meta}）` : body;
}
