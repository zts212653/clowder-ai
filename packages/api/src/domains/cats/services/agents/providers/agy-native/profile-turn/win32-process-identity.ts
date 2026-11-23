import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { UnixProcessIdentity } from '../../../../../../../utils/cli-process-ownership.js';
import { readWindowsJobNamesLinkedTo } from '../../../../../../../utils/windows-job-execution-links.js';
import { jobQueryScript, powershellArgs } from '../../../../../../../utils/windows-job-native.js';
import {
  queryWindowsJobStopEvidence,
  readWindowsJobOwnerRecords,
  type WindowsJobOwnerRecord,
  type WindowsJobStopEvidence,
} from '../../../../../../../utils/windows-job-owner.js';
import type { ProfileTurnOwner } from './store.js';

const POWERSHELL_TIMEOUT_MS = 10_000;
const CHILD_BIRTH_CLOCK_MARGIN_MS = 1_000;
const ROUND_TRIP_UTC_BIRTH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;

export interface Win32ProcessSnapshotRow {
  readonly pid: number;
  readonly ppid: number;
  readonly startedAt: string | null;
  readonly commandLine: string | null;
}

export type Win32JobRetirementEvidence =
  | { readonly status: 'verified_absent'; readonly jobCount: number }
  | { readonly status: 'none' }
  | { readonly status: 'unverified'; readonly reason: string };

export interface Win32RetirementVerdict {
  readonly retired: boolean;
  readonly reason: string;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidBirthString(value: unknown): value is string {
  return typeof value === 'string' && ROUND_TRIP_UTC_BIRTH.test(value) && Number.isFinite(Date.parse(value));
}

function windowsPowerShellPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsPowerShellEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
}

function processBirthScript(pid: number): string {
  // Use the same Win32_Process CIM CreationDate format as #1838 windows-job-native.ts
  // (round-trip 7-digit UTC ISO string). Never swallow read/access errors as "absent".
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `$row = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
    'if ($null -eq $row -or $null -eq $row.CreationDate) { Write-Output "null"; exit 0 }',
    'Write-Output ([ordered]@{',
    '  pid = [int]$row.ProcessId',
    '  ppid = [int]$row.ParentProcessId',
    "  startedAt = $row.CreationDate.ToUniversalTime().ToString('o')",
    '} | ConvertTo-Json -Compress)',
  ].join('\n');
}

function processSnapshotScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {',
    '  $birth = $null',
    "  if ($null -ne $_.CreationDate) { $birth = $_.CreationDate.ToUniversalTime().ToString('o') }",
    '  [ordered]@{',
    '    pid = [int]$_.ProcessId',
    '    ppid = [int]$_.ParentProcessId',
    '    startedAt = $birth',
    '    commandLine = $_.CommandLine',
    '  }',
    '})',
    'ConvertTo-Json -InputObject $rows -Compress -Depth 3',
  ].join('\n');
}

function parseWin32ProcessIdentity(raw: string): UnixProcessIdentity | null {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '').trim()) as {
      pid?: unknown;
      ppid?: unknown;
      startedAt?: unknown;
    } | null;
    if (
      !parsed ||
      !isPositiveSafeInt(parsed.pid) ||
      !isNonNegativeSafeInt(parsed.ppid) ||
      !isValidBirthString(parsed.startedAt)
    ) {
      return null;
    }
    return { pid: parsed.pid, ppid: parsed.ppid, pgid: 0, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

export function parseWin32ProcessSnapshot(raw: string): Win32ProcessSnapshotRow[] | null {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '').trim()) as unknown;
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : null;
    if (!list) return null;
    const rows: Win32ProcessSnapshotRow[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      if (!isNonNegativeSafeInt(row.pid) || !isNonNegativeSafeInt(row.ppid)) return null;
      const startedAt = typeof row.startedAt === 'string' && row.startedAt.trim() ? row.startedAt.trim() : null;
      const commandLine = typeof row.commandLine === 'string' ? row.commandLine : null;
      rows.push({ pid: row.pid, ppid: row.ppid, startedAt, commandLine });
    }
    return rows;
  } catch {
    return null;
  }
}

function commandMatchesMarker(commandLine: string | null, markers: readonly string[]): boolean {
  if (!commandLine) return false;
  const lower = commandLine.toLowerCase();
  for (const marker of markers) {
    const needle = marker.toLowerCase();
    let offset = 0;
    while (offset <= lower.length - needle.length) {
      const idx = lower.indexOf(needle, offset);
      if (idx < 0) break;
      const before = idx === 0 ? '' : (lower[idx - 1] ?? '');
      const after = idx + needle.length === lower.length ? '' : (lower[idx + needle.length] ?? '');
      const beforeBoundary = idx === 0 || /[\s"']/.test(before);
      const afterBoundary = idx + needle.length === lower.length || /[\s"']/.test(after);
      if (beforeBoundary && afterBoundary) return true;
      offset = idx + 1;
    }
  }
  return false;
}

function win32TurnMarkers(owner: ProfileTurnOwner, home: string): string[] {
  if (owner.runHome) {
    const geminiDir = join(owner.runHome, '.gemini');
    const posixGeminiDir = geminiDir.replaceAll('\\', '/');
    return [...new Set([`--gemini_dir=${geminiDir}`, `--gemini_dir=${posixGeminiDir}`])];
  }
  const posixHome = home.replaceAll('\\', '/');
  return [...new Set([`HOME=${home}`, `HOME=${posixHome}`])];
}

function queryWindowsJobStopEvidenceSync(
  record: Pick<WindowsJobOwnerRecord, 'jobName' | 'sessionId'>,
): WindowsJobStopEvidence {
  const unknown = (reason: string): WindowsJobStopEvidence => ({ verdict: 'unknown', activeProcesses: 0, reason });
  const result = spawnSync(windowsPowerShellPath(), powershellArgs(jobQueryScript(record.jobName)), {
    encoding: 'utf8',
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: windowsPowerShellEnv(),
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return unknown(`job_query_failed:${String(result.error ?? result.status)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim().split('\n').pop() ?? '');
  } catch {
    return unknown('job_query_unparseable');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unknown('job_query_unparseable');
  const observed = parsed as Record<string, unknown>;
  if (observed.sessionId !== record.sessionId) {
    return unknown(`job_query_other_session:${String(observed.sessionId)}!=${record.sessionId}`);
  }
  if (observed.state === 'absent') {
    return observed.nativeError === 2
      ? { verdict: 'absent', activeProcesses: 0, reason: 'job_closed_owner_gone' }
      : unknown(`absent_without_error_file_not_found:${String(observed.nativeError)}`);
  }
  if (observed.state === 'present') {
    const active = isNonNegativeSafeInt(observed.activeProcesses) ? observed.activeProcesses : 0;
    return { verdict: 'present', activeProcesses: active, reason: 'job_still_owns_members' };
  }
  return unknown(`job_query_error:${String(observed.nativeError ?? 'unknown')}`);
}

function collectOwnerJobTargets(
  owner: ProfileTurnOwner,
):
  | { readonly ok: true; readonly targets: ReadonlyArray<Pick<WindowsJobOwnerRecord, 'jobName' | 'sessionId'>> }
  | { readonly ok: false; readonly reason: string } {
  const byName = new Map<string, Pick<WindowsJobOwnerRecord, 'jobName' | 'sessionId'>>();
  if (owner.windowsJob) {
    byName.set(owner.windowsJob.jobName, {
      jobName: owner.windowsJob.jobName,
      sessionId: owner.windowsJob.sessionId,
    });
  }
  if (owner.invocationId) {
    const linkedNames = readWindowsJobNamesLinkedTo(owner.invocationId, owner.dataRoot);
    if (linkedNames === null) return { ok: false, reason: 'job_links_unreadable' };
    if (linkedNames.length > 0) {
      const ownerRecords = readWindowsJobOwnerRecords(owner.dataRoot);
      if (ownerRecords.invalidPaths.length > 0) return { ok: false, reason: 'job_owner_records_invalid' };
      const recordByName = new Map(ownerRecords.records.map((entry) => [entry.jobName, entry]));
      for (const jobName of linkedNames) {
        if (byName.has(jobName)) continue;
        const record = recordByName.get(jobName);
        if (!record) return { ok: false, reason: `job_owner_record_missing:${jobName}` };
        byName.set(jobName, { jobName: record.jobName, sessionId: record.sessionId });
      }
    }
  }
  return { ok: true, targets: [...byName.values()] };
}

async function resolveOwnerJobEvidenceAsync(owner: ProfileTurnOwner): Promise<Win32JobRetirementEvidence> {
  const collected = collectOwnerJobTargets(owner);
  if (!collected.ok) return { status: 'unverified', reason: collected.reason };
  if (collected.targets.length === 0) return { status: 'none' };
  for (const target of collected.targets) {
    const evidence = await queryWindowsJobStopEvidence(target);
    if (evidence.verdict !== 'absent') {
      return { status: 'unverified', reason: `job_${evidence.verdict}:${evidence.reason}` };
    }
  }
  return { status: 'verified_absent', jobCount: collected.targets.length };
}

function resolveOwnerJobEvidenceSync(owner: ProfileTurnOwner): Win32JobRetirementEvidence {
  const collected = collectOwnerJobTargets(owner);
  if (!collected.ok) return { status: 'unverified', reason: collected.reason };
  if (collected.targets.length === 0) return { status: 'none' };
  for (const target of collected.targets) {
    const evidence = queryWindowsJobStopEvidenceSync(target);
    if (evidence.verdict !== 'absent') {
      return { status: 'unverified', reason: `job_${evidence.verdict}:${evidence.reason}` };
    }
  }
  return { status: 'verified_absent', jobCount: collected.targets.length };
}

/**
 * Pure fail-closed evaluator for Windows native turn retirement.
 *
 * Proves retirement ONLY when ALL of the following hold:
 * 1. A complete Win32_Process snapshot is available.
 * 2. Owner PID is absent OR reused by a strictly later process whose birth time was read cleanly
 *    (any failure to read owner birth time fails closed — never treated as "process does not exist").
 * 3. No live child of owner PID born during owner's lifetime exists (even when its argv has no
 *    `--gemini_dir` or `CommandLine` is unreadable), and no process carries the turn marker.
 * 4. For non-preparation turns (which may spawn multi-level tool trees whose intermediate parent
 *    exits), #1838 Windows Kernel Job stop evidence (`verdict === 'absent'`) confirms the whole tree
 *    was reaped by the kernel. Any recorded job on a preparation turn must also be verified absent.
 */
export function evaluateWin32NativeTurnRetirement(
  owner: ProfileTurnOwner,
  home: string,
  snapshot: readonly Win32ProcessSnapshotRow[] | null,
  jobEvidence: Win32JobRetirementEvidence,
): Win32RetirementVerdict {
  if (!snapshot) return { retired: false, reason: 'snapshot_unavailable' };
  if (!isValidBirthString(owner.identity.startedAt)) return { retired: false, reason: 'owner_birth_invalid' };
  const ownerStartedMs = Date.parse(owner.identity.startedAt);

  const ownerRow = snapshot.find((row) => row.pid === owner.identity.pid);
  let reusedStartedAt: string | null = null;
  if (ownerRow) {
    // Unreadable or malformed CreationDate on the live process holding owner.pid NEVER proves exit.
    if (!isValidBirthString(ownerRow.startedAt)) {
      return { retired: false, reason: 'owner_birth_unreadable' };
    }
    if (ownerRow.startedAt === owner.identity.startedAt) {
      return { retired: false, reason: 'owner_alive' };
    }
    // PID reuse: the replacement process must be strictly newer than the recorded owner.
    if (ownerRow.startedAt < owner.identity.startedAt) {
      return { retired: false, reason: 'owner_birth_clock_skew' };
    }
    reusedStartedAt = ownerRow.startedAt;
  }

  // Detect live direct children of owner.pid born during the dead owner's lifetime,
  // regardless of whether CommandLine contains `--gemini_dir` or is even readable.
  for (const row of snapshot) {
    if (row.ppid !== owner.identity.pid || row.pid === owner.identity.pid) continue;
    if (!isValidBirthString(row.startedAt)) {
      return { retired: false, reason: 'descendant_birth_unreadable' };
    }
    const childStartedMs = Date.parse(row.startedAt);
    if (childStartedMs < ownerStartedMs - CHILD_BIRTH_CLOCK_MARGIN_MS) continue;
    // If owner.pid was reused by a newer process at `reusedStartedAt`, only children born
    // at or before `reusedStartedAt` can belong to the dead owner; children born strictly
    // after `reusedStartedAt` belong to the unrelated replacement process.
    if (reusedStartedAt !== null && row.startedAt > reusedStartedAt) continue;
    return { retired: false, reason: 'owner_descendant_alive' };
  }

  const markers = win32TurnMarkers(owner, home);
  for (const row of snapshot) {
    if (commandMatchesMarker(row.commandLine, markers)) {
      return { retired: false, reason: 'marker_process_alive' };
    }
  }

  if (jobEvidence.status === 'unverified') {
    return { retired: false, reason: jobEvidence.reason };
  }
  if (!owner.preparation && jobEvidence.status !== 'verified_absent') {
    // Without a closed #1838 Win32 Kernel Job (KILL_ON_JOB_CLOSE), an orphaned grandchild whose
    // intermediate launcher exited cannot be disproved by PPID/argv scanning alone.
    return { retired: false, reason: 'windows_job_evidence_missing' };
  }

  return { retired: true, reason: 'retired_verified' };
}

function readWin32ProcessSnapshotSync(): Win32ProcessSnapshotRow[] | null {
  const result = spawnSync(windowsPowerShellPath(), powershellArgs(processSnapshotScript()), {
    encoding: 'utf8',
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: windowsPowerShellEnv(),
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return parseWin32ProcessSnapshot(result.stdout);
}

function readWin32ProcessSnapshot(): Promise<Win32ProcessSnapshotRow[] | null> {
  return new Promise((resolveSnapshot) => {
    execFile(
      windowsPowerShellPath(),
      powershellArgs(processSnapshotScript()),
      {
        encoding: 'utf8',
        timeout: POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: windowsPowerShellEnv(),
      },
      (error, stdout) => {
        if (error || typeof stdout !== 'string') {
          resolveSnapshot(null);
          return;
        }
        resolveSnapshot(parseWin32ProcessSnapshot(stdout));
      },
    );
  });
}

/** Windows birth-identity probe for AGY native profile turn leases. Fail-closed on error. */
export function readWin32ProcessIdentitySync(pid: number): UnixProcessIdentity | null {
  if (!isPositiveSafeInt(pid)) return null;
  const result = spawnSync(windowsPowerShellPath(), powershellArgs(processBirthScript(pid)), {
    encoding: 'utf8',
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024,
    env: windowsPowerShellEnv(),
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return parseWin32ProcessIdentity(result.stdout);
}

/** Async Windows birth-identity probe so request paths do not block the event loop. */
export function readWin32ProcessIdentity(pid: number): Promise<UnixProcessIdentity | null> {
  if (!isPositiveSafeInt(pid)) return Promise.resolve(null);
  return new Promise((resolveIdentity) => {
    execFile(
      windowsPowerShellPath(),
      powershellArgs(processBirthScript(pid)),
      {
        encoding: 'utf8',
        timeout: POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        env: windowsPowerShellEnv(),
      },
      (error, stdout) => {
        if (error || typeof stdout !== 'string') {
          resolveIdentity(null);
          return;
        }
        resolveIdentity(parseWin32ProcessIdentity(stdout));
      },
    );
  });
}

/** Fail-closed retirement proof on Windows: requires full process-tree + job verification. */
export function isWin32NativeTurnRetiredSync(owner: ProfileTurnOwner, home: string): boolean {
  const snapshot = readWin32ProcessSnapshotSync();
  const jobEvidence = resolveOwnerJobEvidenceSync(owner);
  return evaluateWin32NativeTurnRetirement(owner, home, snapshot, jobEvidence).retired;
}

/** Async fail-closed retirement proof on Windows. */
export async function isWin32NativeTurnRetired(owner: ProfileTurnOwner, home: string): Promise<boolean> {
  const [snapshot, jobEvidence] = await Promise.all([readWin32ProcessSnapshot(), resolveOwnerJobEvidenceAsync(owner)]);
  return evaluateWin32NativeTurnRetirement(owner, home, snapshot, jobEvidence).retired;
}
