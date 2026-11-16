import { execFileSync } from 'node:child_process';

const WINDOWS_CREATION_TOLERANCE_MS = 5_000;

const WINDOWS_PROCESS_QUERY = [
  "$ErrorActionPreference = 'Stop';",
  'Get-CimInstance Win32_Process |',
  'Select-Object ProcessId,ParentProcessId,',
  "@{Name='CreationDate';Expression={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }},",
  'WorkingSetSize,CommandLine | ConvertTo-Json -Compress',
].join(' ');

export function listWindowsProcesses() {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
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

function hasDeadOrReusedWindowsParent(ppid, createdAt, byId) {
  if (!Number.isSafeInteger(ppid) || ppid <= 0) return false;
  const parent = byId.get(ppid);
  if (parent === undefined) return true;
  // Missing timestamps cannot prove that a present parent PID was recycled.
  return (
    parent.createdAt !== undefined &&
    createdAt !== undefined &&
    parent.createdAt > createdAt + WINDOWS_CREATION_TOLERANCE_MS
  );
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
      const orphaned = hasDeadOrReusedWindowsParent(ppid, createdAt, byId);
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

const WINDOWS_TERMINATE_SCRIPT = `
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
