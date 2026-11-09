/**
 * #1838: the native half of Windows API job ownership — the PowerShell/C# bodies and how they are
 * launched. Lifecycle, records and verdicts live in `windows-job-owner.ts`.
 *
 * The bodies are embedded as strings and handed to `-EncodedCommand` rather than shipped as `.ps1`
 * siblings: `tsc` does not copy non-TS assets, so a sibling file would silently go missing from a
 * packaged build and turn every probe into a permanent `unknown`.
 */

export const JOB_NAME_PREFIX = 'Local\\ClowderApiJob-';
/** A provider host's job: its record must also name the API controlling it. */
export const PROVIDER_JOB_NAME_PREFIX = 'Local\\ClowderProviderJob-';

export function isClowderJobName(name: string): boolean {
  return name.startsWith(JOB_NAME_PREFIX) || name.startsWith(PROVIDER_JOB_NAME_PREFIX);
}
export const HELPER_READY = 'JOB_READY_HELPER_OUTSIDE';

/** Shared C# interop; the helper and the query differ only in what they do with the handle. */
const JOB_INTEROP = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class ClowderJobInterop {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long PerProcess, PerJob;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime,
  // ThisPeriodTotalKernelTime, TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminated.
  [StructLayout(LayoutKind.Sequential)] struct BasicAccounting {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodUserTime;
    public long ThisPeriodKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
  // QueryInformationJobObject's result layout depends on the information class; class 1 has its own.
  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
  static extern bool QueryBasicAccounting(IntPtr job, int kind, ref BasicAccounting info, uint size, out uint returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inside);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);

  // 0x2000 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: when the last handle closes, the kernel kills
  // every remaining member. No BREAKAWAY flag is set, so descendants cannot leave the job.
  public static void Configure(IntPtr job) {
    var info = new ExtendedLimit();
    info.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info))) throw new Win32Exception();
  }

  public static int ActiveProcesses(IntPtr job, out uint active) {
    var info = new BasicAccounting();
    uint returned;
    active = 0;
    if (!QueryBasicAccounting(job, 1, ref info, (uint)Marshal.SizeOf(info), out returned))
      return Marshal.GetLastWin32Error();
    active = info.ActiveProcesses;
    return 0;
  }
}
'@
`;

/** PowerShell single-quoted literal: only `'` needs doubling, so no injection surface remains. */
function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The helper: spawned before the API admits any provider, it stays OUTSIDE the job it manages and
 * holds the job's only handle until the API exits.
 *
 * Order matters. Once the API is a member, any helper exit closes the handle and the kernel kills
 * the API with it (KILL_ON_JOB_CLOSE). So everything that can fail for ordinary reasons — identity,
 * job creation, configuration, the durable owner record — happens BEFORE the assign. A record left
 * by a failed assign names a job that never owned anything: it reads absent, has no linked
 * executions, and is cleared. The record also carries the session: the `Local\` name resolves only
 * inside this session, so a query from another session cannot tell "gone" from "not visible".
 *
 * Parameters are bound as literals: PowerShell does not forward trailing `-EncodedCommand` args.
 */
export function jobOwnerScript(input: {
  targetPid: number;
  expectedScript: string;
  jobName: string;
  ownerRecordPath: string;
  /** Provider hosts: the API that started the target, which must be its parent; 0 for none. */
  controllerPid?: number;
}): string {
  const parameters = [
    `$TargetProcessId = ${input.targetPid}`,
    `$ExpectedScript = ${psLiteral(input.expectedScript)}`,
    `$JobName = ${psLiteral(input.jobName)}`,
    `$OwnerRecordPath = ${psLiteral(input.ownerRecordPath)}`,
    `$ControllerPid = ${input.controllerPid ?? 0}`,
  ].join('\n');
  return `$ErrorActionPreference = 'Stop'\n${JOB_INTEROP}\n${parameters}\n${String.raw`
# Only adopt the exact process this deployment started: exact pid, and the script file name (the
# recorded CommandLine keeps whatever path form the process was launched with).
$targetRow = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId" -ErrorAction Stop
if (!$targetRow -or !$targetRow.CommandLine.Contains($ExpectedScript)) { Write-Output 'JOB_FAILED_NOT_OUR_PROCESS'; exit 4 }

# A provider host's job outlives nothing but the host, so its record also names the API that can
# still launch into this execution: exact pid and birth, read while that API waits for this host.
$controller = $null
if ($ControllerPid -ne 0) {
  if ($targetRow.ParentProcessId -ne $ControllerPid) { Write-Output 'JOB_FAILED_CONTROLLER_NOT_PARENT'; exit 11 }
  $controllerRow = Get-CimInstance Win32_Process -Filter "ProcessId = $ControllerPid" -ErrorAction Stop
  if (!$controllerRow -or !$controllerRow.CreationDate) { Write-Output 'JOB_FAILED_CONTROLLER_IDENTITY'; exit 11 }
  $controller = [ordered]@{
    pid       = $ControllerPid
    # Full precision as a round-trip string: a millisecond cut could let a reborn pid read as the same.
    createdAt = $controllerRow.CreationDate.ToUniversalTime().ToString('o')
  }
}

$jobHandle = [ClowderJobInterop]::CreateJobObject([IntPtr]::Zero, $JobName)
if ($jobHandle -eq [IntPtr]::Zero) { Write-Output 'JOB_FAILED_CREATE'; exit 5 }
# SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE
$targetHandle = [ClowderJobInterop]::OpenProcess(0x101101, $false, $TargetProcessId)

try {
  if ($targetHandle -eq [IntPtr]::Zero) { Write-Output 'JOB_FAILED_OPEN'; exit 6 }
  [ClowderJobInterop]::Configure($jobHandle)

  $record = [ordered]@{
    v         = 1
    jobName   = $JobName
    apiPid    = $TargetProcessId
    helperPid = $PID
    sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  if ($controller) { $record['controller'] = $controller }
  $temporaryPath = $OwnerRecordPath + '.' + $PID + '.tmp'
  [System.IO.File]::WriteAllText($temporaryPath, ($record | ConvertTo-Json -Compress))
  [System.IO.File]::Move($temporaryPath, $OwnerRecordPath)

  if (-not [ClowderJobInterop]::AssignProcessToJobObject($jobHandle, $targetHandle)) {
    Write-Output "JOB_FAILED_ASSIGN $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    exit 7
  }

  # From here on an exit also ends the API. Both checks are contradictions of a successful assign,
  # so failing them stops a process whose ownership cannot be trusted rather than admitting writers.
  $hostInside = $false
  $helperInside = $false
  if (-not [ClowderJobInterop]::IsProcessInJob($targetHandle, $jobHandle, [ref]$hostInside)) { Write-Output 'JOB_FAILED_MEMBERSHIP_QUERY'; exit 8 }
  if (-not $hostInside) { Write-Output 'JOB_FAILED_HOST_OUTSIDE'; exit 8 }
  if (-not [ClowderJobInterop]::IsProcessInJob([Diagnostics.Process]::GetCurrentProcess().Handle, $jobHandle, [ref]$helperInside)) { Write-Output 'JOB_FAILED_MEMBERSHIP_QUERY'; exit 8 }
  if ($helperInside) { Write-Output 'JOB_FAILED_HELPER_INSIDE'; exit 9 }

  Write-Output 'JOB_READY_HELPER_OUTSIDE'
  [Console]::Out.Flush()

  # Hold the handle until the API is gone; this exit closes it and the kernel reaps the members.
  # WaitForSingleObject takes a UInt32: a bare 0xFFFFFFFF is inferred as Int32 -1 and throws, which
  # would land in finally, close the job and kill the API at startup.
  $waitResult = [ClowderJobInterop]::WaitForSingleObject($targetHandle, [uint32]::MaxValue)
  if ($waitResult -ne 0) { Write-Output "JOB_FAILED_WAIT $waitResult"; exit 10 }
} finally {
  [void][ClowderJobInterop]::CloseHandle($targetHandle)
  [void][ClowderJobInterop]::CloseHandle($jobHandle)
}
`}`;
}

/**
 * The restart-time query. It reports what it observed plus its own session; the TS side alone
 * decides the verdict. Only `absent` with ERROR_FILE_NOT_FOUND (2) can ever become a stop.
 */
export function jobQueryScript(jobName: string): string {
  return `$ErrorActionPreference = 'Stop'\n${JOB_INTEROP}\n$JobName = ${psLiteral(jobName)}\n${String.raw`
$sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
$jobHandle = [ClowderJobInterop]::OpenJobObject(0x0004, $false, $JobName)
if ($jobHandle -eq [IntPtr]::Zero) {
  # $Error is a read-only automatic variable; use a task-specific name.
  $jobNativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $state = if ($jobNativeError -eq 2) { 'absent' } else { 'unknown' }
  Write-Output ('{"state":"' + $state + '","nativeError":' + $jobNativeError + ',"sessionId":' + $sessionId + '}')
  exit 0
}
try {
  $active = 0
  $queryError = [ClowderJobInterop]::ActiveProcesses($jobHandle, [ref]$active)
  if ($queryError -ne 0) {
    Write-Output ('{"state":"unknown","nativeError":' + $queryError + ',"sessionId":' + $sessionId + '}')
    exit 0
  }
  Write-Output ('{"state":"present","activeProcesses":' + $active + ',"sessionId":' + $sessionId + '}')
} finally {
  [void][ClowderJobInterop]::CloseHandle($jobHandle)
}
`}`;
}

/**
 * Whether each recorded controller still exists as the same process: `alive` (same pid and birth),
 * `gone` (no such pid, or a pid reused by a later process), or `unknown` (the query itself failed).
 * The TS side alone decides what any of these permits.
 */
export function controllerQueryScript(controllers: ReadonlyArray<{ pid: number; createdAt: string }>): string {
  // The unary comma keeps each pair a pair: `@(@(1,2))` would flatten a single entry into `@(1,2)`.
  const list = controllers.map(({ pid, createdAt }) => `$Controllers += ,@(${pid},${psLiteral(createdAt)})`).join('\n');
  return `$ErrorActionPreference = 'Stop'\n$Controllers = @()\n${list}\n${String.raw`
$sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
$verdicts = [ordered]@{}
foreach ($entry in $Controllers) {
  $pidValue = $entry[0]
  $key = "$($entry[0]):$($entry[1])"
  try {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction Stop
  } catch {
    $verdicts[$key] = 'unknown'
    continue
  }
  if (!$row) { $verdicts[$key] = 'gone'; continue }
  $birth = $row.CreationDate.ToUniversalTime().ToString('o')
  $verdicts[$key] = if ($birth -eq $entry[1]) { 'alive' } else { 'gone' }
}
Write-Output ([ordered]@{ sessionId = $sessionId; verdicts = $verdicts } | ConvertTo-Json -Compress)
`}`;
}

/** `-EncodedCommand` takes UTF-16LE base64, which sidesteps all cmd/PowerShell quoting hazards. */
export function powershellArgs(script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}
