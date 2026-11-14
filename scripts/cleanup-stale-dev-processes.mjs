#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStalePencilProbe, PENCIL_PROBE_RULE, pencilOwnedDescendants } from './lib/pencil-codex-probe-policy.mjs';
import { enrichPencilProbes, revalidatePencilFinding } from './lib/pencil-codex-probes.mjs';
import { isCatCafeCommand, STALE_DEV_PROCESS_RULES } from './lib/stale-dev-process-rules.mjs';

export {
  matchAgentBrowserMcpWrapper,
  matchPinchtabMcpWrapper,
  matchPlaywrightMcpWrapper,
} from './lib/stale-dev-process-rules.mjs';

const HOUR = 60 * 60;
const KILL_GRACE_MS = 2000;
const WINDOWS_CREATION_TOLERANCE_MS = 5_000;
const MAX_REPORTED_COMMAND_LENGTH = 500;
const WINDOWS_PROCESS_QUERY = [
  "$ErrorActionPreference = 'Stop';",
  'Get-CimInstance Win32_Process |',
  'Select-Object ProcessId,ParentProcessId,',
  "@{Name='CreationDate';Expression={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }},",
  'WorkingSetSize,CommandLine | ConvertTo-Json -Compress',
].join(' ');

export function formatCommandForReport(command) {
  return command.length <= MAX_REPORTED_COMMAND_LENGTH
    ? command
    : `${command.slice(0, MAX_REPORTED_COMMAND_LENGTH - 3)}...`;
}

export function parseElapsedSeconds(raw) {
  const value = raw.trim();
  const [dayPart, timePart] = value.includes('-') ? value.split('-', 2) : ['0', value];
  const days = Number.parseInt(dayPart, 10);
  const parts = timePart.split(':').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(days) || parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return days * 86400 + minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }
  return undefined;
}

export function parsePsOutput(psOutput) {
  return psOutput
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      const [, pid, ppid, pgid, sess, etime, rss, command] = match;
      return {
        pid: Number.parseInt(pid, 10),
        ppid: Number.parseInt(ppid, 10),
        pgid: Number.parseInt(pgid, 10),
        sess: Number.parseInt(sess, 10),
        elapsed: etime,
        elapsedSeconds: parseElapsedSeconds(etime),
        rssKb: Number.parseInt(rss, 10),
        command,
      };
    })
    .filter(Boolean);
}

function formatElapsed(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const clock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return days > 0 ? `${days}-${clock}` : clock;
}

function windowsCreationMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return undefined;
  const serialized = value.match(/^\/Date\((-?\d+)\)\/$/);
  if (serialized) return Number(serialized[1]);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Windows process snapshots come from Get-CimInstance and use backslashes,
 * .exe/.cmd basenames, and dead-parent PIDs instead of POSIX PID 1. */
export function parseWindowsProcessList(raw, { nowMs = Date.now() } = {}) {
  const decoded = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  const rows = Array.isArray(decoded) ? decoded : [decoded];
  const byId = new Map();
  for (const row of rows) {
    const pid = Number(row?.ProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const createdAt = windowsCreationMs(row.CreationDate);
    byId.set(pid, { pid, createdAt });
  }
  return rows
    .map((row) => {
      const pid = Number(row?.ProcessId);
      const ppid = Number(row?.ParentProcessId);
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      const createdAt = windowsCreationMs(row.CreationDate);
      const elapsedSeconds = createdAt === undefined ? undefined : Math.max(0, Math.floor((nowMs - createdAt) / 1000));
      const command = String(row.CommandLine ?? '')
        .replaceAll('\\', '/')
        .trim();
      const rss = Number(row.WorkingSetSize);
      const parent = byId.get(ppid);
      // Windows keeps the dead parent PID. A live PID alone is not evidence:
      // if the parent PID was reused by a newer process, the child is orphaned.
      // Missing timestamps are treated conservatively as "parent may exist" so
      // an unverifiable snapshot cannot expand cleanup scope.
      const orphaned =
        Number.isSafeInteger(ppid) && ppid > 0
          ? parent === undefined ||
            (parent.createdAt !== undefined &&
              createdAt !== undefined &&
              parent.createdAt > createdAt + WINDOWS_CREATION_TOLERANCE_MS)
          : false;
      return {
        pid,
        ppid: Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : 0,
        pgid: 0,
        sess: 0,
        elapsed: elapsedSeconds === undefined ? '?' : formatElapsed(elapsedSeconds),
        elapsedSeconds,
        rssKb: Number.isFinite(rss) ? Math.round(rss / 1024) : 0,
        command,
        createdAt,
        orphaned,
      };
    })
    .filter(Boolean);
}

export function findStaleDevProcesses(
  processes,
  { ownPid = process.pid, nowMs = Date.now(), pencilOnly = false } = {},
) {
  const findings = [];
  const protectedPencilHelpers = pencilOwnedDescendants(processes);
  for (const proc of processes) {
    if (proc.pid === ownPid || protectedPencilHelpers.has(proc.pid)) continue;
    if (proc.elapsedSeconds === undefined) continue;
    if (isStalePencilProbe(proc, processes, nowMs)) {
      findings.push({
        ...proc,
        ruleId: PENCIL_PROBE_RULE,
        reason: 'Pencil SDK login probe has no progress for over one hour',
      });
      continue;
    }
    const rule =
      !pencilOnly &&
      STALE_DEV_PROCESS_RULES.find(
        (candidate) => proc.elapsedSeconds >= candidate.minAgeSeconds && candidate.match(proc),
      );
    if (rule) findings.push({ ...proc, ruleId: rule.id, reason: rule.reason });
  }
  return findings;
}

export function findLongLivedDevProcesses(processes, { ownPid = process.pid } = {}) {
  return processes
    .filter(
      (proc) =>
        proc.pid !== ownPid &&
        proc.elapsedSeconds !== undefined &&
        proc.elapsedSeconds >= 8 * HOUR &&
        (isCatCafeCommand(proc.command) || /(?:^|\s)--filter(?:=|\s+)@cat-cafe\/web(?:\s|$)/.test(proc.command)) &&
        /(?:^|\s)(?:\S*\/)?next(?:\/dist\/bin\/next)?\s+dev(?:\s|$)/.test(proc.command),
    )
    .map((proc) => ({
      ...proc,
      ruleId: 'long-lived-cat-cafe-next-dev',
      reason: 'long-lived Clowder AI Next dev watcher; inspect managed preview ownership before stopping',
    }));
}

function listProcesses(platform = process.platform) {
  if (platform === 'win32') {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,sess=,etime=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function printFindings(findings, advisories = []) {
  if (findings.length === 0) {
    console.log('[stale-dev-processes] no cleanup-safe stale Clowder AI dev processes found');
  }
  for (const item of findings) {
    console.log(
      [
        `[stale-dev-processes] pid=${item.pid}`,
        `ppid=${item.ppid}`,
        `etime=${item.elapsed}`,
        `rss=${item.rssKb}KB`,
        `rule=${item.ruleId}`,
        `reason="${item.reason}"`,
        `cmd=${formatCommandForReport(item.command)}`,
      ].join(' '),
    );
  }
  for (const item of advisories) {
    console.log(
      [
        `[stale-dev-processes] advisory pid=${item.pid}`,
        `ppid=${item.ppid}`,
        `etime=${item.elapsed}`,
        `rss=${item.rssKb}KB`,
        `rule=${item.ruleId}`,
        `reason="${item.reason}"`,
        `cmd=${formatCommandForReport(item.command)}`,
      ].join(' '),
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

export function readWindowsCreationMs(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p -and $p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') }`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  }).trim();
  return output ? windowsCreationMs(output) : undefined;
}

const WINDOWS_TERMINATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ClowderProcess {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool TerminateProcess(IntPtr handle, uint exitCode);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
}
"@
$pidValue = [int]$env:CLOWDER_TARGET_PID
$handle = [ClowderProcess]::OpenProcess(0x1001, $false, $pidValue)
if ($handle -eq [IntPtr]::Zero) {
  $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "OPEN_FAILED:$lastError"
}
try {
  [long]$creation = 0
  [long]$exitTime = 0
  [long]$kernelTime = 0
  [long]$userTime = 0
  if (-not [ClowderProcess]::GetProcessTimes($handle, [ref]$creation, [ref]$exitTime, [ref]$kernelTime, [ref]$userTime)) {
    $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "QUERY_FAILED:$lastError"
  }
  $actual = [DateTime]::FromFileTimeUtc($creation)
  $expected = [DateTime]::Parse($env:CLOWDER_TARGET_CREATED).ToUniversalTime()
  if ([Math]::Abs(($actual - $expected).TotalMilliseconds) -gt 5000) {
    throw 'RECYCLED'
  }
  if (-not [ClowderProcess]::TerminateProcess($handle, 1)) {
    $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "TERMINATE_FAILED:$lastError"
  }
} finally {
  [void][ClowderProcess]::CloseHandle($handle)
}
`;

/** Open, identity-check and terminate the same process handle.
 * Looking up a PID and then invoking an external kill command leaves a PID-reuse window; this
 * script keeps the opened handle for both GetProcessTimes and TerminateProcess. */
export function killWindowsProcess(pid, item, { execFileImpl = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw Object.assign(new Error(`invalid process id: ${pid}`), { code: 'ESRCH' });
  }
  if (typeof item?.createdAt !== 'number' || !Number.isFinite(item.createdAt)) {
    throw Object.assign(new Error(`process ${pid} has no snapshot creation time; refusing to terminate`), {
      code: 'ESRCH',
    });
  }
  try {
    execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TERMINATE_SCRIPT], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: {
        ...process.env,
        CLOWDER_TARGET_PID: String(pid),
        CLOWDER_TARGET_CREATED: new Date(item.createdAt).toISOString(),
      },
    });
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? '');
    if (/OPEN_FAILED:(?:87|1168)/.test(message) || /QUERY_FAILED|RECYCLED/.test(message)) {
      throw Object.assign(new Error(`process ${pid} is already gone or was recycled`), { code: 'ESRCH', cause: error });
    }
    throw error;
  }
}

function defaultKill(pid, _signal, item) {
  if (process.platform === 'win32') return killWindowsProcess(pid, item);
  return process.kill(pid, _signal);
}

function sendSignal(item, signal, killFn) {
  try {
    killFn(item.pid, signal, item);
    return { status: 'sent' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { status: 'gone' };
    return { status: 'failed', failure: { pid: item.pid, signal, err: error } };
  }
}

function recordSignalOutcome(result, outcome, signal) {
  if (outcome.status === 'sent') result[signal === 'SIGTERM' ? 'sigtermSent' : 'sigkillSent']++;
  else if (outcome.status === 'gone') result.alreadyGone++;
  else result.failed.push(outcome.failure);
}

export async function terminateFindings(
  findings,
  {
    killFn = defaultKill,
    existsFn = processExists,
    sleepFn = sleep,
    graceMs = KILL_GRACE_MS,
    revalidatePencilFn = revalidatePencilFinding,
    protectedPids = new Set([process.pid, process.ppid]),
  } = {},
) {
  const result = {
    sigtermSent: 0,
    sigkillSent: 0,
    alreadyGone: 0,
    skippedChanged: 0,
    skippedProtected: 0,
    failed: [],
  };
  const pending = [];

  for (const item of findings) {
    if (protectedPids.has(item.pid)) {
      result.skippedProtected++;
      continue;
    }
    if (item.ruleId === PENCIL_PROBE_RULE && !revalidatePencilFn(item)) {
      result.skippedChanged++;
      continue;
    }
    const outcome = sendSignal(item, 'SIGTERM', killFn);
    recordSignalOutcome(result, outcome, 'SIGTERM');
    if (outcome.status === 'sent') pending.push(item);
  }

  if (pending.length > 0) {
    await sleepFn(graceMs);
  }

  for (const item of pending) {
    if (!existsFn(item.pid)) {
      result.alreadyGone++;
      continue;
    }
    if (item.ruleId === PENCIL_PROBE_RULE) {
      result.failed.push({ pid: item.pid, signal: 'SIGTERM', err: 'probe remains alive; no force-kill escalation' });
      continue;
    }
    const outcome = sendSignal(item, 'SIGKILL', killFn);
    recordSignalOutcome(result, outcome, 'SIGKILL');
  }

  return result;
}

async function killFindings(findings) {
  const result = await terminateFindings(findings);
  console.log(
    `[stale-dev-processes] sigterm=${result.sigtermSent} sigkill=${result.sigkillSent} gone=${result.alreadyGone} skippedChanged=${result.skippedChanged} skippedProtected=${result.skippedProtected} failed=${result.failed.length}`,
  );
  if (result.failed.length > 0) {
    process.exitCode = 1;
    for (const failure of result.failed) {
      console.error(`[stale-dev-processes] failed pid=${failure.pid} signal=${failure.signal}: ${String(failure.err)}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const run = argv.includes('--run');
  const pencilOnly = argv.includes('--pencil-only');
  let processes;
  try {
    const output = listProcesses();
    processes = enrichPencilProbes(
      process.platform === 'win32' ? parseWindowsProcessList(output) : parsePsOutput(output),
    );
  } catch (error) {
    console.error(
      `[stale-dev-processes] failed to enumerate processes; no processes were inspected or terminated: ${String(
        error instanceof Error ? error.message : error,
      )}`,
    );
    process.exitCode = 1;
    return;
  }
  const findings = findStaleDevProcesses(processes, { pencilOnly });
  const advisories = pencilOnly ? [] : findLongLivedDevProcesses(processes);
  printFindings(findings, advisories);
  if (run) await killFindings(findings);
}

function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryPath = realpathSync(resolve(entry));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32'
      ? entryPath.toLowerCase() === modulePath.toLowerCase()
      : entryPath === modulePath;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  await main();
}
