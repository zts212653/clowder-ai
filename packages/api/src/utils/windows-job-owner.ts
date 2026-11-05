/**
 * #1838: durable Windows API job ownership and cross-restart stop evidence.
 *
 * The problem this closes: a Windows provider launched by an API instance that is then force-killed
 * leaves a durable TurnExecution stuck `running`, because nothing can prove the native writer
 * stopped. All the in-band evidence is gone with the process (exit watchers live in memory), and
 * every out-of-band reconstruction fails against the same measured counterexample:
 *
 *   root → launcher → writer, where the launcher exits first, leaves the writer alive with a
 *   ParentProcessId naming the dead launcher. `taskkill /T /F` on the root misses it, and walking
 *   the process table down from a dead root cannot reach it either.
 *
 * So the fix does not try to reconstruct a stop after the fact. It gives the tree a kernel-held
 * owner up front: a helper process puts the API into a randomly-named Win32 Job Object with
 * KILL_ON_JOB_CLOSE, stays outside that job, and holds the only handle. When the API dies — however
 * violently — the handle closes and the kernel terminates every member it still attributes to the
 * job, PPID chain or not.
 *
 * After a restart the only question left is whether that job is gone, and `OpenJobObject` answers
 * it exactly: ERROR_FILE_NOT_FOUND means the owner is gone and its tree was reaped. Nothing else
 * counts — a failed query, a missing record, or an unreachable helper all stay `unknown` and keep
 * the execution protected.
 *
 * The PowerShell bodies are embedded as strings and handed to `-EncodedCommand` rather than shipped
 * as `.ps1` siblings: `tsc` does not copy non-TS assets, so a sibling file would silently go
 * missing from a packaged build and turn every probe into a permanent `unknown`.
 */

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveCatCafeDataRoot } from './cli-process-ownership.js';

const execFileAsync = promisify(execFile);

const WINDOWS_JOB_DIRECTORY = 'windows-api-jobs';
const JOB_NAME_PREFIX = 'Local\\ClowderApiJob-';
const HELPER_READY = 'JOB_READY_HELPER_OUTSIDE';
const HELPER_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 10_000;

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
  // QueryInformationJobObject is a single export whose result layout depends on the information
  // class, so each class gets its own P/Invoke signature over the matching structure.
  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
  static extern bool QueryBasicAccounting(IntPtr job, int kind, ref BasicAccounting info, uint size, out uint returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size, out uint returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inside);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);

  // 0x2000 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: when the last handle closes, the kernel kills
  // every remaining member. This is the whole mechanism: an abandoned API reaps its own tree.
  public static void Configure(IntPtr job) {
    var info = new ExtendedLimit();
    info.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info))) throw new Win32Exception();
  }

  public static int ActiveProcesses(IntPtr job, out uint active) {
    // JobObjectBasicAccountingInformation (class 1) has its own layout; reuse of the extended-limit
    // struct for this query returns ERROR_BAD_LENGTH (24).
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

/**
 * The helper. It must be spawned before the API could otherwise be adopted, stays OUTSIDE the job
 * it manages (self-checked), and writes the durable owner record only after a successful assign.
 * A process cannot reliably put itself into a fresh job, which is why this is a separate process.
 *
 * Parameters are bound as literals inside the script rather than passed after `-EncodedCommand`:
 * PowerShell does not forward trailing arguments to `-EncodedCommand` (they are echoed as output),
 * so values must be embedded. `psLiteral` escapes them.
 */
function jobOwnerScript(input: {
  targetPid: number;
  expectedScript: string;
  jobName: string;
  ownerRecordPath: string;
}): string {
  return (
    `$ErrorActionPreference = 'Stop'\n` +
    JOB_INTEROP +
    String.raw`
$TargetProcessId = ` +
    String(input.targetPid) +
    String.raw`
$ExpectedScript = ` +
    psLiteral(input.expectedScript) +
    String.raw`
$JobName = ` +
    psLiteral(input.jobName) +
    String.raw`
$OwnerRecordPath = ` +
    psLiteral(input.ownerRecordPath) +
    String.raw`
# Only ever adopt the one exact process this deployment started. The pid is exact; the command line
# is matched by its file name only, because Win32_Process records the path as it was invoked
# (typically relative) while the caller knows an absolute path.
$targetRow = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId" -ErrorAction Stop
if (!$targetRow -or !$targetRow.CommandLine.Contains($ExpectedScript)) {
  Write-Output 'JOB_FAILED_NOT_OUR_PROCESS'
  exit 4
}

$jobHandle = [ClowderJobInterop]::CreateJobObject([IntPtr]::Zero, $JobName)
if ($jobHandle -eq [IntPtr]::Zero) { Write-Output 'JOB_FAILED_CREATE'; exit 5 }
$targetHandle = [ClowderJobInterop]::OpenProcess(0x100101, $false, $TargetProcessId)

try {
  if ($targetHandle -eq [IntPtr]::Zero) { Write-Output 'JOB_FAILED_OPEN'; exit 6 }
  [ClowderJobInterop]::Configure($jobHandle)

  if (-not [ClowderJobInterop]::AssignProcessToJobObject($jobHandle, $targetHandle)) {
    Write-Output "JOB_FAILED_ASSIGN $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    exit 7
  }

  # The helper must stay outside the job it manages, or its own exit would close the handle early.
  $helperInside = $false
  if (-not [ClowderJobInterop]::IsProcessInJob([Diagnostics.Process]::GetCurrentProcess().Handle, $jobHandle, [ref]$helperInside)) {
    Write-Output 'JOB_FAILED_MEMBERSHIP_QUERY'
    exit 8
  }
  if ($helperInside) { Write-Output 'JOB_FAILED_HELPER_INSIDE'; exit 9 }

  # Durable ownership lands here, BEFORE the caller is told it may admit providers.
  $record = [ordered]@{
    v         = 1
    jobName   = $JobName
    apiPid    = $TargetProcessId
    helperPid = $PID
    createdAt = [int][double]::Parse((Get-Date -UFormat %s)) * 1000
  }
  $json = $record | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($OwnerRecordPath, $json)

  Write-Output 'JOB_READY_HELPER_OUTSIDE'
  [Console]::Out.Flush()

  # Hold the handle until the API is gone; our exit closes it and the kernel reaps the members.
  # WaitForSingleObject takes a UInt32; PowerShell infers the bare literal 0xFFFFFFFF as Int32 -1,
  # which throws on conversion. That failure lands in the finally block, closes the job handle, and
  # the kernel then kills this very process (KILL_ON_JOB_CLOSE) — so the API would die at startup
  # and appear to be unable to spawn anything.
  $waitResult = [ClowderJobInterop]::WaitForSingleObject($targetHandle, [uint32]::MaxValue)
  if ($waitResult -ne 0) { Write-Output "JOB_FAILED_WAIT $waitResult"; exit 10 }
} finally {
  [void][ClowderJobInterop]::CloseHandle($targetHandle)
  [void][ClowderJobInterop]::CloseHandle($jobHandle)
}
`
  );
}

/**
 * The restart-time query. Three-valued on purpose:
 *   absent  -> OpenJobObject failed with ERROR_FILE_NOT_FOUND (2): the owning API is gone and its
 *              job closed, so its tree was reaped. Only this licenses a stop.
 *   present -> the job still exists; `activeProcesses` counts live members.
 *   unknown -> the query itself failed. Never a stop proof.
 */
function jobQueryScript(jobName: string): string {
  return (
    `$ErrorActionPreference = 'Stop'\n` +
    JOB_INTEROP +
    String.raw`
$JobName = ` +
    psLiteral(jobName) +
    String.raw`
$JOB_OBJECT_QUERY = 0x0004
$jobHandle = [ClowderJobInterop]::OpenJobObject($JOB_OBJECT_QUERY, $false, $JobName)
if ($jobHandle -eq [IntPtr]::Zero) {
  # $Error is a PowerShell automatic variable and cannot be assigned; use a task-specific name.
  $jobNativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  # ONLY ERROR_FILE_NOT_FOUND (2) means the owner is gone and its tree was reaped. Any other code
  # (access denied, invalid name, ...) leaves the question open and must not read as a stop.
  if ($jobNativeError -eq 2) { Write-Output '{"state":"absent","nativeError":2}'; exit 0 }
  Write-Output ('{"state":"unknown","nativeError":' + $jobNativeError + '}')
  exit 0
}

try {
  $active = 0
  $queryError = [ClowderJobInterop]::ActiveProcesses($jobHandle, [ref]$active)
  if ($queryError -ne 0) {
    Write-Output ('{"state":"unknown","nativeError":' + $queryError + '}')
    exit 0
  }
  Write-Output ('{"state":"present","activeProcesses":' + $active + '}')
} finally {
  [void][ClowderJobInterop]::CloseHandle($jobHandle)
}
`
  );
}

/** `-EncodedCommand` takes UTF-16LE base64, which sidesteps all cmd/PowerShell quoting hazards. */
function encodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** PowerShell single-quoted literal: only `'` needs doubling, so no injection surface remains. */
function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(script)];
}

export type WindowsJobStopVerdict = 'absent' | 'present' | 'unknown';

export interface WindowsJobOwnerRecord {
  v: 1;
  jobName: string;
  /** The API process the kernel job owns; its death is what closes the job. */
  apiPid: number;
  helperPid: number;
  createdAt: number;
  /** Path this record was read from, when it came from disk. */
  path?: string;
}

export interface WindowsJobStopEvidence {
  verdict: WindowsJobStopVerdict;
  /** Members still attributed to the job when it is present; 0 for absent/unknown. */
  activeProcesses: number;
  reason: string;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseWindowsJobOwnerRecord(value: unknown): WindowsJobOwnerRecord | null {
  const record = asRecord(value);
  if (!record || record.v !== 1) return null;
  if (typeof record.jobName !== 'string' || !record.jobName.startsWith(JOB_NAME_PREFIX)) return null;
  if (!isPositiveSafeInteger(record.apiPid) || !isPositiveSafeInteger(record.helperPid)) return null;
  if (!isPositiveSafeInteger(record.createdAt)) return null;
  return {
    v: 1,
    jobName: record.jobName,
    apiPid: record.apiPid,
    helperPid: record.helperPid,
    createdAt: record.createdAt,
  };
}

export function resolveWindowsJobDirectory(dataDir?: string): string {
  return join(resolveCatCafeDataRoot(dataDir), WINDOWS_JOB_DIRECTORY);
}

export interface WindowsJobAdoption {
  adopted: boolean;
  record?: WindowsJobOwnerRecord;
  /** Why adoption failed; the caller must not admit providers on a failed adoption. */
  reason?: string;
}

export interface WindowsJobAdoptionOptions {
  dataDir?: string;
  /** Injected for tests; defaults to this process. */
  targetPid?: number;
  expectedScript?: string;
  spawnHelper?: typeof spawn;
}

/**
 * Put this API process into its own kernel job.
 *
 * Any failure — no PowerShell, refused assignment, helper died — returns `adopted: false` with a
 * reason. The caller MUST treat that as "no stop evidence will exist for this instance": a writer
 * started now could never be provably stopped after a crash, which is exactly the defect this
 * fixes, so admitting one anyway would reintroduce it silently.
 */
export async function adoptWindowsApiJob(options: WindowsJobAdoptionOptions = {}): Promise<WindowsJobAdoption> {
  if (process.platform !== 'win32') return { adopted: false, reason: 'not_windows' };

  const targetPid = options.targetPid ?? process.pid;
  // Identity is the exact pid plus the script file name; the recorded CommandLine keeps whatever
  // path form the process was launched with, so only the basename is a stable common substring.
  const expectedScript = basename(options.expectedScript ?? process.argv[1] ?? '');
  const jobName = `${JOB_NAME_PREFIX}${randomUUID()}`;
  let directory: string;
  const recordPath = (): string => join(directory, `${randomUUID()}.json`);
  try {
    directory = resolveWindowsJobDirectory(options.dataDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  } catch (error) {
    return { adopted: false, reason: `job_directory_unavailable:${String(error)}` };
  }
  const ownerRecordPath = recordPath();

  const spawnHelper = options.spawnHelper ?? spawn;
  const helper = spawnHelper(
    'powershell.exe',
    powershellArgs(
      jobOwnerScript({
        targetPid,
        expectedScript,
        jobName,
        ownerRecordPath,
      }),
    ),
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );

  const outcome = await new Promise<string>((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish('JOB_FAILED_TIMEOUT'), HELPER_TIMEOUT_MS);
    helper.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(HELPER_READY)) finish(HELPER_READY);
      else if (stdout.includes('JOB_FAILED')) finish(stdout.trim().split('\n').pop() ?? 'JOB_FAILED');
    });
    helper.once('error', (error) => finish(`JOB_FAILED_SPAWN:${error.message}`));
    helper.once('exit', (code) => finish(stdout.includes(HELPER_READY) ? HELPER_READY : `JOB_FAILED_EXIT:${code}`));
  });

  if (outcome !== HELPER_READY) {
    helper.kill();
    rmSync(ownerRecordPath, { force: true });
    return { adopted: false, reason: outcome };
  }

  const record = readWindowsJobOwnerRecord(ownerRecordPath);
  if (!record || record.jobName !== jobName) {
    helper.kill();
    rmSync(ownerRecordPath, { force: true });
    return { adopted: false, reason: 'owner_record_missing_after_ready' };
  }
  // The helper intentionally outlives this call, holding the job handle; it is not a child we wait
  // on, and it exits by itself once the query above proves the API is gone.
  helper.unref();
  return { adopted: true, record: { ...record, path: ownerRecordPath } };
}

export function readWindowsJobOwnerRecord(path: string): WindowsJobOwnerRecord | null {
  try {
    return parseWindowsJobOwnerRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export interface WindowsJobOwnerScan {
  records: Array<WindowsJobOwnerRecord & { path: string }>;
  /** Records that could not be parsed; their API instances stay protected as unknown. */
  invalidPaths: string[];
}

export function readWindowsJobOwnerRecords(dataDir?: string): WindowsJobOwnerScan {
  const directory = resolveWindowsJobDirectory(dataDir);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], invalidPaths: [] };
    throw error;
  }
  const records: Array<WindowsJobOwnerRecord & { path: string }> = [];
  const invalidPaths: string[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const record = readWindowsJobOwnerRecord(path);
    if (!record) invalidPaths.push(path);
    else records.push({ ...record, path });
  }
  return { records, invalidPaths };
}

export function clearWindowsJobOwner(path: string): void {
  rmSync(path, { force: true });
}

export interface WindowsJobQueryOptions {
  execute?: typeof execFileAsync;
}

/**
 * Query the recorded job from this (fresh) process.
 *
 * Only an explicit "the job object does not exist" proves the owning API and everything the kernel
 * attributed to it are gone. Every other outcome — a present job, a permission error, unparseable
 * output, a probe that never ran — keeps the execution protected.
 */
export async function queryWindowsJobStopEvidence(
  jobName: string,
  options: WindowsJobQueryOptions = {},
): Promise<WindowsJobStopEvidence> {
  const run = options.execute ?? execFileAsync;
  let stdout: string;
  try {
    const result = await run('powershell.exe', powershellArgs(jobQueryScript(jobName)), {
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    return { verdict: 'unknown', activeProcesses: 0, reason: `job_query_failed:${String(error)}` };
  }

  const lastLine = stdout.trim().split('\n').pop() ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return { verdict: 'unknown', activeProcesses: 0, reason: 'job_query_unparseable' };
  }
  const record = asRecord(parsed);
  if (!record) return { verdict: 'unknown', activeProcesses: 0, reason: 'job_query_unparseable' };
  // `absent` requires the exact native code. A bare `{state:'absent'}` (or any other code) is not
  // proof that the owner is gone, so the boundary rejects it rather than trusting the label.
  if (record.state === 'absent') {
    if (record.nativeError !== 2) {
      return {
        verdict: 'unknown',
        activeProcesses: 0,
        reason: `absent_without_error_file_not_found:${String(record.nativeError)}`,
      };
    }
    return { verdict: 'absent', activeProcesses: 0, reason: 'job_closed_owner_gone' };
  }
  if (record.state === 'present') {
    // A present job with an unusable count is still present (never stopped), but the count must be
    // a real non-negative integer or the caller would see a fabricated membership figure.
    const active = record.activeProcesses;
    if (typeof active !== 'number' || !Number.isInteger(active) || active < 0) {
      return { verdict: 'present', activeProcesses: 0, reason: 'job_present_count_unusable' };
    }
    return { verdict: 'present', activeProcesses: active, reason: 'job_still_owns_members' };
  }
  return {
    verdict: 'unknown',
    activeProcesses: 0,
    reason: `job_query_error:${String(record.nativeError ?? 'unknown')}`,
  };
}

export interface WindowsJobStopResolution {
  /** API instances whose job is verifiably gone, with the record paths to clear after settlement. */
  verifiedStopped: Array<{ apiPid: number; helperPid: number; recordPath: string }>;
  /** Jobs that still exist or could not be queried; their executions stay protected and visible. */
  unresolved: Array<{ apiPid: number; verdict: WindowsJobStopVerdict; reason: string; activeProcesses: number }>;
}

/**
 * Resolve every durable job record into a stop verdict.
 *
 * This is the startup hook: only `absent` may release executions, and this function writes no
 * execution state itself, so the existing settlement path stays the single writer.
 */
export async function resolveWindowsJobStopEvidence(
  options: { dataDir?: string; execute?: typeof execFileAsync } = {},
): Promise<WindowsJobStopResolution> {
  const { records, invalidPaths } = readWindowsJobOwnerRecords(options.dataDir);
  const verifiedStopped: WindowsJobStopResolution['verifiedStopped'] = [];
  const unresolved: WindowsJobStopResolution['unresolved'] = [];
  for (const record of records) {
    const evidence = await queryWindowsJobStopEvidence(record.jobName, options);
    if (evidence.verdict === 'absent')
      verifiedStopped.push({ apiPid: record.apiPid, helperPid: record.helperPid, recordPath: record.path });
    else
      unresolved.push({
        apiPid: record.apiPid,
        verdict: evidence.verdict,
        reason: evidence.reason,
        activeProcesses: evidence.activeProcesses,
      });
  }
  for (const path of invalidPaths) {
    unresolved.push({ apiPid: 0, verdict: 'unknown', reason: `owner_record_unreadable:${path}`, activeProcesses: 0 });
  }
  return { verifiedStopped, unresolved };
}
