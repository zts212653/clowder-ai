/**
 * #1838: durable Windows provider ownership and cross-restart stop evidence.
 *
 * Unix providers are owned by `cli-supervisor`, whose atomic manifest is the crash-recovery
 * owner. Windows has no supervisor manifest, so a provider launched by an API process that was
 * then force-killed left no stop evidence behind: the durable TurnExecution kept `running`
 * with `providerStartedAt` and no `providerTeardownAt`, restart recovery could not prove the
 * native writer had exited, and every later message to that thread/cat stayed blocked.
 *
 * This module records the exact native identity of a spawned provider *before* anything can
 * consume it, and classifies that identity after a restart:
 *
 * - alive            — the exact PID with the exact creation time still exists.
 * - verified-stopped — the identity is gone AND no descendant of it is still running.
 * - unknown          — the question could not be answered (probe failed, malformed record).
 *
 * Identity is PID + CreationDate, never the process name or a parent PID alone: Win32_Process
 * reuses PIDs and leaves a stale ParentProcessId after the parent dies. Measured on Windows 11:
 * a child survives its parent's death and still reports the dead parent's PID, so a missing root
 * PID proves nothing about the tree, and the tree must be checked explicitly.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CliExecutionOwnerRef } from './cli-process-ownership.js';
import { resolveCatCafeDataRoot } from './cli-process-ownership.js';

const WINDOWS_CHILD_DIRECTORY = 'windows-cli-child-owners';
const OWNER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROBE_TIMEOUT_MS = 4_000;

/** Exact native process identity: PID plus its creation time, which PID reuse cannot forge. */
export interface WindowsProcessIdentity {
  pid: number;
  /** Raw Win32_Process.CreationDate as sub-second ticks; the only stable birth marker. */
  creationDate: string;
}

export interface WindowsChildOwnerRecord {
  v: 1;
  ownerId: string;
  createdAt: number;
  /** Durable execution join key back to the TurnExecution this child wrote. */
  execution: CliExecutionOwnerRef;
  /** The provider process this API instance started. */
  root: WindowsProcessIdentity;
}

export type WindowsStopVerdict = 'alive' | 'verified-stopped' | 'unknown';

export interface WindowsStopEvidence {
  verdict: WindowsStopVerdict;
  /** Provider root and any descendant still running, for a precise active-execution reference. */
  liveProcessIds: number[];
  reason: string;
}

interface RawWindowsProcess {
  pid: number;
  ppid: number;
  creationDate: string;
}

export type ReadWindowsProcessTable = () => Promise<Map<number, RawWindowsProcess> | null>;

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseWindowsProcessIdentity(value: unknown): WindowsProcessIdentity | null {
  const record = asRecord(value);
  if (!record || !isPositiveSafeInteger(record.pid)) return null;
  if (typeof record.creationDate !== 'string' || record.creationDate.trim() === '') return null;
  return { pid: record.pid, creationDate: record.creationDate.trim() };
}

function parseExecutionRef(value: unknown): CliExecutionOwnerRef | null {
  const record = asRecord(value);
  if (!record) return null;
  const fields = ['executionId', 'invocationId', 'threadId', 'catId', 'userId'] as const;
  const parsed: Partial<Record<(typeof fields)[number], string>> = {};
  for (const field of fields) {
    const raw = record[field];
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    parsed[field] = raw.trim();
  }
  return parsed as CliExecutionOwnerRef;
}

export function parseWindowsChildOwnerRecord(value: unknown): WindowsChildOwnerRecord | null {
  const record = asRecord(value);
  if (!record || record.v !== 1) return null;
  if (typeof record.ownerId !== 'string' || !OWNER_ID_RE.test(record.ownerId)) return null;
  if (!isPositiveSafeInteger(record.createdAt)) return null;
  const execution = parseExecutionRef(record.execution);
  if (!execution) return null;
  const root = parseWindowsProcessIdentity(record.root);
  if (!root) return null;
  return { v: 1, ownerId: record.ownerId, createdAt: record.createdAt, execution, root };
}

export function resolveWindowsChildOwnerDirectory(dataDir?: string): string {
  return join(resolveCatCafeDataRoot(dataDir), WINDOWS_CHILD_DIRECTORY);
}

/**
 * The exact Win32_Process rows for the given PIDs. Returns null when the probe could not run,
 * so a failed probe reads as `unknown` and never as "nothing is there".
 */
export async function readWindowsProcessTable(
  pids: readonly number[],
  execFileImpl: typeof execFile = execFile,
): Promise<Map<number, RawWindowsProcess> | null> {
  const wanted = pids.filter(isPositiveSafeInteger);
  if (wanted.length === 0) return new Map();
  // One bounded query for the whole snapshot; the request path must never start a
  // PowerShell process per owner. -Filter keeps the result set to the PIDs we asked about.
  const filter = wanted.map((pid) => `ProcessId = ${pid}`).join(' OR ');
  const script = [
    `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue |`,
    'ForEach-Object { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.Ticks }',
  ].join(' ');
  return new Promise((resolveTable) => {
    execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error || typeof stdout !== 'string') {
          resolveTable(null);
          return;
        }
        const table = new Map<number, RawWindowsProcess>();
        for (const line of stdout.split('\n')) {
          const [pid, ppid, creationDate] = line.trim().split('\t');
          const parsedPid = Number(pid);
          const parsedPpid = Number(ppid);
          if (!isPositiveSafeInteger(parsedPid) || !Number.isInteger(parsedPpid)) continue;
          if (typeof creationDate !== 'string' || creationDate.trim() === '') continue;
          table.set(parsedPid, { pid: parsedPid, ppid: parsedPpid, creationDate: creationDate.trim() });
        }
        resolveTable(table);
      },
    );
  });
}

/** The whole table, used only to walk descendants of a dead root. */
async function readFullWindowsProcessTable(
  execFileImpl: typeof execFile = execFile,
): Promise<Map<number, RawWindowsProcess> | null> {
  const script = [
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    'ForEach-Object { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.Ticks }',
  ].join(' ');
  return new Promise((resolveTable) => {
    execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error || typeof stdout !== 'string') {
          resolveTable(null);
          return;
        }
        const table = new Map<number, RawWindowsProcess>();
        for (const line of stdout.split('\n')) {
          const [pid, ppid, creationDate] = line.trim().split('\t');
          const parsedPid = Number(pid);
          const parsedPpid = Number(ppid);
          if (!isPositiveSafeInteger(parsedPid) || !Number.isInteger(parsedPpid)) continue;
          if (typeof creationDate !== 'string' || creationDate.trim() === '') continue;
          table.set(parsedPid, { pid: parsedPid, ppid: parsedPpid, creationDate: creationDate.trim() });
        }
        resolveTable(table);
      },
    );
  });
}

/**
 * Classify every recorded identity against one process table.
 *
 * A missing root PID is NOT enough to call the provider stopped: measured on Windows 11, a child
 * outlives its parent and keeps reporting the dead parent's PID, so the tree is walked explicitly.
 *
 * Three distinct cases, never collapsed:
 * - root PID gone entirely  → walk its stale-PPID descendants; none left means verified-stopped.
 * - root PID present, same creation time → alive.
 * - root PID present, different creation time → the PID was REUSED. The recorded provider is gone
 *   but its former descendants are indistinguishable from the new process's children, so the
 *   answer is unknown and no PID is reported. Reporting the new process's children here would let
 *   an operator Stop unrelated processes.
 */
export function classifyWindowsStopEvidence(
  roots: readonly WindowsProcessIdentity[],
  table: ReadonlyMap<number, RawWindowsProcess> | null,
  options: { fullTable?: ReadonlyMap<number, RawWindowsProcess> | null } = {},
): WindowsStopEvidence {
  if (!table) return { verdict: 'unknown', liveProcessIds: [], reason: 'process_probe_failed' };
  const root = roots[0];
  if (!root) return { verdict: 'unknown', liveProcessIds: [], reason: 'identity_missing' };

  const observedRoot = table.get(root.pid);
  if (observedRoot) {
    return observedRoot.creationDate === root.creationDate
      ? { verdict: 'alive', liveProcessIds: [root.pid], reason: 'provider_root_alive' }
      : { verdict: 'unknown', liveProcessIds: [], reason: 'pid_reused_identity_mismatch' };
  }

  // Root PID is absent. Descendants may still run with a stale ParentProcessId, so the tree is
  // walked. A full-table read that failed is unknown, never "stopped".
  const full = options.fullTable;
  if (!full) return { verdict: 'unknown', liveProcessIds: [], reason: 'process_tree_probe_failed' };

  const live: number[] = [];
  const pending = [root.pid];
  const seen = new Set<number>(pending);
  while (pending.length > 0) {
    const parent = pending.pop() as number;
    for (const candidate of full.values()) {
      if (candidate.ppid !== parent || seen.has(candidate.pid)) continue;
      seen.add(candidate.pid);
      live.push(candidate.pid);
      pending.push(candidate.pid);
    }
  }
  return live.length > 0
    ? { verdict: 'alive', liveProcessIds: live, reason: 'provider_descendant_alive' }
    : { verdict: 'verified-stopped', liveProcessIds: [], reason: 'provider_tree_stopped' };
}

/** Probe once, then classify many records against the same snapshots. */
export async function probeWindowsStopEvidence(
  roots: readonly WindowsProcessIdentity[],
  options: {
    readTable?: ReadWindowsProcessTable;
    readFullTable?: () => Promise<Map<number, RawWindowsProcess> | null>;
  } = {},
): Promise<WindowsStopEvidence> {
  const uniquePids = [...new Set(roots.map((root) => root.pid))];
  const table = await (options.readTable ?? (() => readWindowsProcessTable(uniquePids)))();
  if (!table) return { verdict: 'unknown', liveProcessIds: [], reason: 'process_probe_failed' };
  const rootMissing = roots.some((root) => !table.has(root.pid));
  const fullTable = rootMissing ? await (options.readFullTable ?? readFullWindowsProcessTable)() : undefined;
  return classifyWindowsStopEvidence(roots, table, { fullTable });
}

function atomicWrite(path: string, record: WindowsChildOwnerRecord): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Record the exact identity of a provider this API instance just started, before the provider
 * can write anything. Registering after the provider runs would let a crash leave a writer with
 * no owner, which is exactly the defect this closes.
 */
export function recordWindowsChildOwner(options: {
  dataDir?: string;
  execution: CliExecutionOwnerRef;
  root: WindowsProcessIdentity;
}): { path: string; record: WindowsChildOwnerRecord } {
  const directory = resolveWindowsChildOwnerDirectory(options.dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const ownerId = randomUUID();
  const record: WindowsChildOwnerRecord = {
    v: 1,
    ownerId,
    createdAt: Date.now(),
    execution: options.execution,
    root: options.root,
  };
  const path = join(directory, `${ownerId}.json`);
  atomicWrite(path, record);
  return { path, record };
}

export interface WindowsChildOwnerScan {
  records: WindowsChildOwnerRecord[];
  /** Records that could not be parsed; their executions stay protected as unknown. */
  invalidPaths: string[];
}

export function readWindowsChildOwnerRecords(dataDir?: string): WindowsChildOwnerScan {
  const directory = resolveWindowsChildOwnerDirectory(dataDir);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], invalidPaths: [] };
    throw error;
  }
  const records: WindowsChildOwnerRecord[] = [];
  const invalidPaths: string[] = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const record = parseWindowsChildOwnerRecord(JSON.parse(readFileSync(path, 'utf8')));
      if (!record || name !== `${record.ownerId}.json`) {
        invalidPaths.push(path);
        continue;
      }
      records.push(record);
    } catch {
      invalidPaths.push(path);
    }
  }
  return { records, invalidPaths };
}

/** Remove a record once its execution settled; the evidence is no longer needed. */
export function clearWindowsChildOwner(path: string): void {
  rmSync(path, { force: true });
}

export interface WindowsStopResolution {
  /** Execution ids whose exact provider identity is verified stopped in this pass. */
  verifiedStoppedInvocationIds: string[];
  /** Execution ids that are alive or unknown; they keep their protection and stay visible. */
  unresolved: Array<{ invocationId: string; verdict: WindowsStopVerdict; reason: string; liveProcessIds: number[] }>;
}

/**
 * Turn durable Windows ownership records into consumable stop evidence for startup recovery.
 *
 * Only `verified-stopped` may release an execution. `alive` and `unknown` keep the existing
 * admission protection; this function never writes execution state itself, so the settlement
 * path stays the single writer.
 */
export async function resolveWindowsStopEvidence(
  options: {
    dataDir?: string;
    readTable?: ReadWindowsProcessTable;
    readFullTable?: () => Promise<Map<number, RawWindowsProcess> | null>;
  } = {},
): Promise<WindowsStopResolution> {
  const { records, invalidPaths } = readWindowsChildOwnerRecords(options.dataDir);
  const verifiedStoppedInvocationIds: string[] = [];
  const unresolved: WindowsStopResolution['unresolved'] = [];
  // A malformed record cannot prove anything about its execution, so it is reported unknown
  // rather than silently dropped: a dropped record looks identical to "no provider ever ran".
  for (const record of records) {
    const evidence = await probeWindowsStopEvidence([record.root], options);
    if (evidence.verdict === 'verified-stopped') verifiedStoppedInvocationIds.push(record.execution.invocationId);
    else
      unresolved.push({
        invocationId: record.execution.invocationId,
        verdict: evidence.verdict,
        reason: evidence.reason,
        liveProcessIds: evidence.liveProcessIds,
      });
  }
  for (const path of invalidPaths) {
    unresolved.push({
      invocationId: `unknown:${path}`,
      verdict: 'unknown',
      reason: 'owner_record_unreadable',
      liveProcessIds: [],
    });
  }
  return { verifiedStoppedInvocationIds, unresolved };
}
