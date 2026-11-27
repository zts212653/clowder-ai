import { execFile, spawnSync } from 'node:child_process';

/**
 * Process start identity across the #2025 locale fix.
 *
 * Current readers record `ps -o lstart` in the C locale (`Thu Nov 26 18:10:51 2026`). Builds before the fix
 * recorded it in the caller's locale, and under a non-C locale the text could also absorb the first word of
 * the command (`四 11月/26 18:10:51 2026 /usr/bin/node`). Such a legacy value can never equal a C-locale read,
 * so treating that inequality as "the process is gone" would signal or discard a live owner after an
 * upgrade. Instead, a legacy value is compared only against a read reproduced exactly as the old build made
 * it, which keeps its identity checks byte-for-byte as before: a live owner still matches, and an absent or
 * reused PID still does not.
 */

const C_LOCALE_LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u;
const LEGACY_READ_TIMEOUT_MS = 2_000;
const LEGACY_READ_MAX_BUFFER = 32 * 1024 * 1024;
const legacyStartedAtByEntry = new WeakMap<object, string>();

export function isCLocaleProcessStart(startedAt: string): boolean {
  return C_LOCALE_LSTART.test(startedAt);
}

/** True when the inherited locale may format `lstart` differently from C, so legacy records can exist. */
export function legacyProcessStartReadNeeded(environment: NodeJS.ProcessEnv = process.env): boolean {
  const locale = environment.LC_ALL || environment.LC_TIME || environment.LANG || '';
  return !(locale === '' || locale === 'C' || locale === 'POSIX' || /^(C|en_US)([._@]|$)/u.test(locale));
}

/** The legacy-format start of a snapshot entry, attached without becoming part of its serialized shape. */
export function legacyProcessStartOf(entry: object | undefined): string | undefined {
  return entry ? legacyStartedAtByEntry.get(entry) : undefined;
}

export function attachLegacyProcessStarts(
  entries: Iterable<{ pid: number }>,
  legacyStarts: ReadonlyMap<number, string>,
): void {
  for (const entry of entries) {
    const legacy = legacyStarts.get(entry.pid);
    if (legacy !== undefined) legacyStartedAtByEntry.set(entry, legacy);
  }
}

/**
 * Arguments the pre-fix build used for the same snapshot, minus the macOS environment payload: the old
 * worker's `eww … command=` line starts with the same command word, which is all the legacy text kept.
 */
export function legacyProcessStartArgs(
  includeEnvironment: boolean,
  pids: readonly number[] | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const selection = pids ? ['-p', pids.join(',')] : ['-ax'];
  if (includeEnvironment && platform === 'linux') return ['-ww', ...selection, '-o', 'pid=,ppid=,pgid=,lstart='];
  return ['-ww', ...selection, '-o', 'pid=,ppid=,pgid=,lstart=,command='];
}

type ParseLegacyLine = (line: string) => { pid: number; startedAt: string } | null;

function collectLegacyStarts(
  stdout: string,
  failed: boolean,
  exitCode: unknown,
  stderr: unknown,
  pids: readonly number[] | undefined,
  parseLine: ParseLegacyLine,
): Map<number, string> | null {
  if (failed) {
    const emptyExactRead = pids !== undefined && exitCode === 1 && !stdout.trim() && !String(stderr ?? '').trim();
    return emptyExactRead ? new Map() : null;
  }
  const starts = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const entry = parseLine(line);
    if (entry) starts.set(entry.pid, entry.startedAt);
  }
  return starts;
}

/** Re-reads start times in the inherited locale, parsed exactly as the pre-fix build did. Null means unknown. */
export function readLegacyProcessStartsSync(
  includeEnvironment: boolean,
  pids: readonly number[] | undefined,
  parseLine: ParseLegacyLine,
): Map<number, string> | null {
  const result = spawnSync('/bin/ps', legacyProcessStartArgs(includeEnvironment, pids), {
    encoding: 'utf8',
    env: process.env,
    timeout: LEGACY_READ_TIMEOUT_MS,
    maxBuffer: LEGACY_READ_MAX_BUFFER,
  });
  if (typeof result.stdout !== 'string') return null;
  const failed = Boolean(result.error) || result.status !== 0 || result.signal !== null;
  return collectLegacyStarts(result.stdout, failed, result.status, result.stderr, pids, parseLine);
}

export function readLegacyProcessStarts(
  includeEnvironment: boolean,
  pids: readonly number[] | undefined,
  parseLine: ParseLegacyLine,
): Promise<Map<number, string> | null> {
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      legacyProcessStartArgs(includeEnvironment, pids),
      { encoding: 'utf8', env: process.env, timeout: LEGACY_READ_TIMEOUT_MS, maxBuffer: LEGACY_READ_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (typeof stdout !== 'string') return resolve(null);
        resolve(collectLegacyStarts(stdout, Boolean(error), error?.code, stderr, pids, parseLine));
      },
    );
  });
}

/** Attaches legacy starts to a fresh C-locale snapshot when legacy records can exist; null when unknown. */
export function withLegacyProcessStartsSync<T extends { pid: number }>(
  snapshot: Map<number, T>,
  includeEnvironment: boolean,
  pids: readonly number[] | undefined,
  parseLine: ParseLegacyLine,
): Map<number, T> | null {
  if (!legacyProcessStartReadNeeded()) return snapshot;
  const legacyStarts = readLegacyProcessStartsSync(includeEnvironment, pids, parseLine);
  if (legacyStarts === null) return null;
  attachLegacyProcessStarts(snapshot.values(), legacyStarts);
  return snapshot;
}

export async function withLegacyProcessStarts<T extends { pid: number }>(
  snapshot: Map<number, T>,
  includeEnvironment: boolean,
  pids: readonly number[] | undefined,
  parseLine: ParseLegacyLine,
): Promise<Map<number, T> | null> {
  if (!legacyProcessStartReadNeeded()) return snapshot;
  const legacyStarts = await readLegacyProcessStarts(includeEnvironment, pids, parseLine);
  if (legacyStarts === null) return null;
  attachLegacyProcessStarts(snapshot.values(), legacyStarts);
  return snapshot;
}
