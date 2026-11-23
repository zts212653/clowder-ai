import type { CodexUsageItem } from './quota.js';

const MAX_SCREEN_ROWS = 4096;
const MAX_SCREEN_COLS = 1024;
const SYNC_OUTPUT_BEGIN = '\u001b[?2026h';
const SYNC_OUTPUT_END = '\u001b[?2026l';

interface VirtualScreenRow {
  chars: string[];
  writeSeq: number;
}

export interface RenderedTerminalRow {
  readonly rowIndex: number;
  readonly writeSeq: number;
  readonly text: string;
}

interface CursorState {
  row: number;
  col: number;
  savedRow: number;
  savedCol: number;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function ensureScreenRow(rows: Map<number, VirtualScreenRow>, r: number): VirtualScreenRow {
  let row = rows.get(r);
  if (!row) {
    row = { chars: [], writeSeq: 0 };
    rows.set(r, row);
  }
  return row;
}

function applyEraseInLine(rows: Map<number, VirtualScreenRow>, cursor: CursorState, mode: number): void {
  const row = ensureScreenRow(rows, cursor.row);
  if (mode === 2) {
    row.chars = [];
    return;
  }
  if (mode === 1) {
    const limit = Math.min(row.chars.length - 1, cursor.col);
    for (let c = 0; c <= limit; c += 1) row.chars[c] = ' ';
    return;
  }
  row.chars.length = Math.min(row.chars.length, cursor.col);
}

function applyEraseInDisplay(rows: Map<number, VirtualScreenRow>, cursor: CursorState, mode: number): void {
  if (mode === 2 || mode === 3) {
    rows.clear();
    return;
  }
  if (mode === 0) {
    const row = rows.get(cursor.row);
    if (row) row.chars.length = Math.min(row.chars.length, cursor.col);
    for (const key of [...rows.keys()]) {
      if (key > cursor.row) rows.delete(key);
    }
  }
}

function applyCsiSequence(
  rows: Map<number, VirtualScreenRow>,
  cursor: CursorState,
  paramsRaw: string,
  finalChar: string,
): void {
  if (!finalChar || /^[?>=<]/.test(paramsRaw)) return;
  const parts = paramsRaw ? paramsRaw.split(';').map((p) => Number.parseInt(p, 10)) : [];
  const p0Pos = Number.isFinite(parts[0]) && (parts[0] as number) > 0 ? (parts[0] as number) : 1;
  const p0Zero = Number.isFinite(parts[0]) && (parts[0] as number) >= 0 ? (parts[0] as number) : 0;
  const p1Pos = Number.isFinite(parts[1]) && (parts[1] as number) > 0 ? (parts[1] as number) : 1;

  switch (finalChar) {
    case 'H':
    case 'f':
      cursor.row = clamp(p0Pos - 1, 0, MAX_SCREEN_ROWS - 1);
      cursor.col = clamp(p1Pos - 1, 0, MAX_SCREEN_COLS - 1);
      return;
    case 'G':
    case '`':
      cursor.col = clamp(p0Pos - 1, 0, MAX_SCREEN_COLS - 1);
      return;
    case 'd':
      cursor.row = clamp(p0Pos - 1, 0, MAX_SCREEN_ROWS - 1);
      return;
    case 'A':
      cursor.row = clamp(cursor.row - p0Pos, 0, MAX_SCREEN_ROWS - 1);
      return;
    case 'B':
    case 'e':
      cursor.row = clamp(cursor.row + p0Pos, 0, MAX_SCREEN_ROWS - 1);
      return;
    case 'C':
    case 'a':
      cursor.col = clamp(cursor.col + p0Pos, 0, MAX_SCREEN_COLS - 1);
      return;
    case 'D':
      cursor.col = clamp(cursor.col - p0Pos, 0, MAX_SCREEN_COLS - 1);
      return;
    case 'E':
      cursor.row = clamp(cursor.row + p0Pos, 0, MAX_SCREEN_ROWS - 1);
      cursor.col = 0;
      return;
    case 'F':
      cursor.row = clamp(cursor.row - p0Pos, 0, MAX_SCREEN_ROWS - 1);
      cursor.col = 0;
      return;
    case 'K':
      applyEraseInLine(rows, cursor, p0Zero);
      return;
    case 'J':
      applyEraseInDisplay(rows, cursor, p0Zero);
      return;
    case 's':
      cursor.savedRow = cursor.row;
      cursor.savedCol = cursor.col;
      return;
    case 'u':
      cursor.row = cursor.savedRow;
      cursor.col = cursor.savedCol;
      return;
    default:
      return;
  }
}

function skipTerminatedControlString(raw: string, startAfterIntro: number): number {
  let j = startAfterIntro;
  while (j < raw.length) {
    if (raw.charCodeAt(j) === 0x07) return j + 1;
    if (raw.charCodeAt(j) === 0x1b && raw[j + 1] === '\\') return j + 2;
    j += 1;
  }
  return j;
}

function consumeEscape(raw: string, index: number, rows: Map<number, VirtualScreenRow>, cursor: CursorState): number {
  const next = raw[index + 1];
  if (!next) return index + 1;
  if (next === '[') {
    let j = index + 2;
    while (j < raw.length && raw.charCodeAt(j) >= 0x30 && raw.charCodeAt(j) <= 0x3f) j += 1;
    const paramsRaw = raw.slice(index + 2, j);
    while (j < raw.length && raw.charCodeAt(j) >= 0x20 && raw.charCodeAt(j) <= 0x2f) j += 1;
    const finalChar = j < raw.length ? (raw[j] ?? '') : '';
    applyCsiSequence(rows, cursor, paramsRaw, finalChar);
    return Math.min(raw.length, j + 1);
  }
  if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
    return skipTerminatedControlString(raw, index + 2);
  }
  if (next === '7') {
    cursor.savedRow = cursor.row;
    cursor.savedCol = cursor.col;
  } else if (next === '8') {
    cursor.row = cursor.savedRow;
    cursor.col = cursor.savedCol;
  } else if (next === 'c') {
    rows.clear();
    cursor.row = 0;
    cursor.col = 0;
  } else if (next === 'D') {
    cursor.row = clamp(cursor.row + 1, 0, MAX_SCREEN_ROWS - 1);
  } else if (next === 'E') {
    cursor.row = clamp(cursor.row + 1, 0, MAX_SCREEN_ROWS - 1);
    cursor.col = 0;
  } else if (next === 'M') {
    cursor.row = clamp(cursor.row - 1, 0, MAX_SCREEN_ROWS - 1);
  }
  return index + 2;
}

function snapshotRows(rows: Map<number, VirtualScreenRow>): RenderedTerminalRow[] {
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rowIndex, row]) => ({
      rowIndex,
      writeSeq: row.writeSeq,
      text: row.chars.join('').trimEnd(),
    }))
    .filter((entry) => entry.text.length > 0);
}

/**
 * Reconstruct logical terminal screen rows from a raw PTY byte/UTF-16 stream,
 * preserving cursor-addressed rows (`CSI row;col H`), line erases (`CSI K`),
 * and carriage-return (`\r`) in-place overwrites.
 */
export function renderTerminalScreenRows(raw: string): RenderedTerminalRow[] {
  const rows = new Map<number, VirtualScreenRow>();
  let lastBeforeFullClear: RenderedTerminalRow[] = [];
  const cursor: CursorState = { row: 0, col: 0, savedRow: 0, savedCol: 0 };
  let seq = 0;
  let i = 0;

  while (i < raw.length) {
    const code = raw.charCodeAt(i);
    if (code === 0x1b) {
      const hadRows = rows.size > 0;
      const snapshotCandidate = hadRows && raw.startsWith('\u001b[2J', i) ? snapshotRows(rows) : null;
      i = consumeEscape(raw, i, rows, cursor);
      if (snapshotCandidate && rows.size === 0 && snapshotCandidate.length > 0) {
        lastBeforeFullClear = snapshotCandidate;
      }
      continue;
    }
    if (code === 0x0d) {
      cursor.col = 0;
      i += 1;
      continue;
    }
    if (code === 0x0a) {
      cursor.row = clamp(cursor.row + 1, 0, MAX_SCREEN_ROWS - 1);
      cursor.col = 0;
      i += 1;
      continue;
    }
    if (code === 0x08) {
      cursor.col = Math.max(0, cursor.col - 1);
      i += 1;
      continue;
    }
    if (code < 0x20 && code !== 0x09) {
      i += 1;
      continue;
    }

    const cp = raw.codePointAt(i) ?? code;
    const ch = code === 0x09 ? ' ' : String.fromCodePoint(cp);
    if (cursor.row < MAX_SCREEN_ROWS && cursor.col < MAX_SCREEN_COLS) {
      const row = ensureScreenRow(rows, cursor.row);
      while (row.chars.length < cursor.col) row.chars.push(' ');
      row.chars[cursor.col] = ch;
      row.writeSeq = ++seq;
      cursor.col += 1;
    }
    i += cp > 0xffff ? 2 : 1;
  }

  const current = snapshotRows(rows);
  return current.length > 0 ? current : lastBeforeFullClear;
}

export function hasUnclosedSynchronizedOutput(raw: string): boolean {
  const begin = raw.lastIndexOf(SYNC_OUTPUT_BEGIN);
  if (begin === -1) return false;
  const closedAt = Math.max(raw.lastIndexOf(SYNC_OUTPUT_END), raw.lastIndexOf('\u001bc'));
  return begin > closedAt;
}

export function parseKimiRelativeDurationMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^reset$/i.test(trimmed)) return 0;
  const body = trimmed.replace(/^resets\s+in\s+/i, '').trim();
  if (!body) return undefined;
  const tokenRe = /(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?=\s|$|\d|,)/gi;
  let totalMs = 0;
  let matchedCount = 0;
  for (const match of body.matchAll(tokenRe)) {
    const value = Number.parseFloat(match[1] ?? '');
    const unit = (match[2] ?? '').toLowerCase()[0];
    if (!Number.isFinite(value) || value < 0) return undefined;
    const unitMs =
      unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 0;
    if (!unitMs) return undefined;
    totalMs += Math.round(value * unitMs);
    matchedCount += 1;
  }
  if (matchedCount === 0 || totalMs < 0) return undefined;
  const remainder = body.replace(tokenRe, '').replace(/[\s,]+/g, '');
  return remainder.length === 0 ? totalMs : undefined;
}

function normalizeQuotaPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function parseWindowResetClause(tail: string, observedAtMs: number): { resetsText?: string; resetsAt?: string } {
  const resetsInMatch = tail.match(/(?:\(\s*)?resets\s+in\s+([^│\r\n)]+)/i);
  if (resetsInMatch?.[1]?.trim()) {
    const resetsText = `Resets in ${resetsInMatch[1].trim()}`;
    const durationMs = parseKimiRelativeDurationMs(resetsText);
    const resetsAt =
      durationMs !== undefined && Number.isFinite(observedAtMs)
        ? new Date(observedAtMs + durationMs).toISOString()
        : undefined;
    return { resetsText, ...(resetsAt ? { resetsAt } : {}) };
  }
  if (/(?:\(\s*)?\breset\b(?:\s*\))?/i.test(tail)) {
    const resetsAt = Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : undefined;
    return { resetsText: 'Reset', ...(resetsAt ? { resetsAt } : {}) };
  }
  return {};
}

const WINDOW_HEADER_RE = /\b(weekly(?:\s+limit)?|(?:5h|5\s*hour|5-hour)(?:\s+limit)?|monthly(?:\s+limit)?)\b/gi;

function extractLineWindowRecords(
  line: string,
  observedAtMs: number,
): Array<{ poolId: 'kimi-weekly' | 'kimi-rate-limit'; item: CodexUsageItem }> {
  const headers = [...line.matchAll(WINDOW_HEADER_RE)];
  const records: Array<{ poolId: 'kimi-weekly' | 'kimi-rate-limit'; item: CodexUsageItem }> = [];

  for (let idx = 0; idx < headers.length; idx += 1) {
    const header = headers[idx];
    if (!header) continue;
    const start = header.index ?? 0;
    const end = idx + 1 < headers.length ? (headers[idx + 1]?.index ?? line.length) : line.length;
    const kindLower = (header[1] ?? '').toLowerCase();
    if (kindLower.startsWith('monthly')) continue;

    const segment = line.slice(start, end);
    const pctMatch = segment.match(/(\d+(?:\.\d+)?)%\s*(left|used)\b/i);
    if (!pctMatch) continue;

    const percent = normalizeQuotaPercent(Number.parseFloat(pctMatch[1] ?? '0'));
    const percentKind: 'remaining' | 'used' = (pctMatch[2] ?? '').toLowerCase() === 'left' ? 'remaining' : 'used';
    const tail = segment.slice((pctMatch.index ?? 0) + pctMatch[0].length);
    const resetMeta = parseWindowResetClause(tail, observedAtMs);
    const isWeekly = kindLower.startsWith('weekly');
    const poolId = isWeekly ? 'kimi-weekly' : 'kimi-rate-limit';

    records.push({
      poolId,
      item: {
        label: isWeekly ? '每周使用限额' : '5小时使用限额',
        usedPercent: percent,
        percentKind,
        poolId,
        ...resetMeta,
      },
    });
  }

  return records;
}

export function parseKimiCliUsageOutput(text: string, observedAtMs: number = Date.now()): CodexUsageItem[] {
  if (hasUnclosedSynchronizedOutput(text)) return [];
  const screenRows = renderTerminalScreenRows(text);
  const order: Array<'kimi-weekly' | 'kimi-rate-limit'> = [];
  const candidates: Array<{
    poolId: 'kimi-weekly' | 'kimi-rate-limit';
    writeSeq: number;
    seqTieBreak: number;
    item: CodexUsageItem;
  }> = [];

  let tie = 0;
  for (const row of screenRows) {
    for (const record of extractLineWindowRecords(row.text, observedAtMs)) {
      if (!order.includes(record.poolId)) order.push(record.poolId);
      candidates.push({
        poolId: record.poolId,
        writeSeq: row.writeSeq,
        seqTieBreak: ++tie,
        item: record.item,
      });
    }
  }

  candidates.sort((a, b) => a.writeSeq - b.writeSeq || a.seqTieBreak - b.seqTieBreak);
  const byPool = new Map<'kimi-weekly' | 'kimi-rate-limit', CodexUsageItem>();
  for (const entry of candidates) {
    byPool.set(entry.poolId, entry.item);
  }
  return order.flatMap((poolId) => {
    const found = byPool.get(poolId);
    return found ? [found] : [];
  });
}
