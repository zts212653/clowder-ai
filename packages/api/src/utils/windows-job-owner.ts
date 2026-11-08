/**
 * #1838: durable Windows API job ownership and cross-restart stop evidence.
 *
 * The problem this closes: a Windows provider launched by an API instance that is then force-killed
 * leaves a durable TurnExecution stuck `running`, because nothing can prove the native writer
 * stopped. In-band evidence (exit watchers) dies with the process, and every out-of-band
 * reconstruction fails against the same measured counterexample: root → launcher → writer, where
 * the launcher exits first, leaves the writer alive with a ParentProcessId naming the dead launcher.
 * `taskkill /T /F` on the root misses it, and walking down from a dead root cannot reach it.
 *
 * So the tree gets a kernel-held owner up front: a helper puts the API into a randomly named Win32
 * Job Object with KILL_ON_JOB_CLOSE, stays outside it, and holds the only handle. When the API dies
 * — however violently — the handle closes and the kernel terminates every member, PPID chain or not.
 * After a restart, `OpenJobObject` from the same session answering ERROR_FILE_NOT_FOUND proves the
 * owner is gone and its tree was reaped. Every other outcome stays `unknown`.
 *
 * Boundary: this owns the API and its descendants. A process created outside that tree (e.g. via
 * WMI `Win32_Process.Create`) is not a member and is not claimed.
 */

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveCatCafeDataRoot } from './cli-process-ownership.js';
import {
  controllerQueryScript,
  HELPER_READY,
  JOB_NAME_PREFIX,
  jobOwnerScript,
  jobQueryScript,
  PROVIDER_JOB_NAME_PREFIX,
  powershellArgs,
} from './windows-job-native.js';

const execFileAsync = promisify(execFile);

const WINDOWS_JOB_DIRECTORY = 'windows-api-jobs';
// Adoption blocks startup before listen and normally takes about 1s (PowerShell + Add-Type). A
// stalled helper costs this whole bound and then falls back to the pre-#1838 manual stop check, so
// it matches the restart query's bound instead of adding up to 30s to a slow start.
const HELPER_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 10_000;

export type WindowsJobStopVerdict = 'absent' | 'present' | 'unknown';

export interface WindowsJobOwnerRecord {
  v: 1;
  jobName: string;
  /** The API process the kernel job owns; its death is what closes the job. */
  apiPid: number;
  helperPid: number;
  /** The session whose `Local\` namespace holds the job name; another session cannot see it. */
  sessionId: number;
  createdAt: number;
  /**
   * Provider-host jobs only: the API that started the host and can still launch into its execution.
   * The job closing proves that host's tree gone; only this API's exit proves no further host comes.
   */
  controller?: { pid: number; createdAt: string };
}

export type WindowsJobOwnerEntry = WindowsJobOwnerRecord & { path: string };

export interface WindowsJobStopEvidence {
  verdict: WindowsJobStopVerdict;
  /** Members still attributed to the job when it is present; 0 for absent/unknown. */
  activeProcesses: number;
  reason: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Session ids and member counts; session 0 (services) is a real session, so zero is valid. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The exact form the native side records a process birth in: `DateTime.ToUniversalTime()
 * .ToString('o')`, seven fractional digits and `Z`. Shape alone is not identity: an impossible
 * calendar value would differ from the live controller's real birth and read as a different, gone
 * process, so `isNativeBirth` also checks real calendar semantics below.
 */
const NATIVE_BIRTH = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/;
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Whether a `ToString('o')` birth is a real instant. The seven fractional digits are kept exactly;
 * no Date conversion or normalization runs here, so an impossible value stays unreadable instead of
 * becoming a guessed identity that could manufacture a "gone" verdict.
 */
function isNativeBirth(value: string): boolean {
  const match = NATIVE_BIRTH.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lastDay = month === 2 && leap ? 29 : DAYS_PER_MONTH[month - 1];
  return day >= 1 && day <= lastDay;
}

export function parseWindowsJobOwnerRecord(value: unknown): WindowsJobOwnerRecord | null {
  const record = asRecord(value);
  if (!record || record.v !== 1 || typeof record.jobName !== 'string') return null;
  if (!isPositiveSafeInteger(record.apiPid) || !isPositiveSafeInteger(record.helperPid)) return null;
  if (!isNonNegativeSafeInteger(record.sessionId) || !isPositiveSafeInteger(record.createdAt)) return null;
  const controller = asRecord(record.controller);
  const validController =
    controller &&
    isPositiveSafeInteger(controller.pid) &&
    typeof controller.createdAt === 'string' &&
    isNativeBirth(controller.createdAt)
      ? { pid: controller.pid, createdAt: controller.createdAt }
      : null;
  // The prefix fixes the kind: a provider-host job without a usable controller is unreadable, never
  // read as the API-member kind whose own death a closed job already proved.
  const kindValid = record.jobName.startsWith(PROVIDER_JOB_NAME_PREFIX)
    ? validController !== null
    : record.jobName.startsWith(JOB_NAME_PREFIX) && record.controller === undefined;
  if (!kindValid) return null;
  return {
    v: 1,
    jobName: record.jobName,
    apiPid: record.apiPid,
    helperPid: record.helperPid,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    ...(validController ? { controller: validController } : {}),
  };
}

export function resolveWindowsJobDirectory(dataDir?: string): string {
  return join(resolveCatCafeDataRoot(dataDir), WINDOWS_JOB_DIRECTORY);
}

export interface WindowsApiJob {
  record: WindowsJobOwnerEntry;
  /** Data root holding this job's owner record and its execution links. */
  dataDir: string;
}

export type WindowsJobAdoption = { adopted: true; job: WindowsApiJob } | { adopted: false; reason: string };

let currentApiJob: WindowsApiJob | null = null;

/** This process's own job once adopted; null before adoption, after a failure, or off Windows. */
export function currentWindowsApiJob(): WindowsApiJob | null {
  return currentApiJob;
}

/**
 * Put this API process into its own kernel job. Must finish before any provider is admitted.
 *
 * On failure providers run without a job link, which is the pre-#1838 behaviour: after a crash
 * their executions stay protected and need a manual check. The helper is never killed here, even
 * on a timeout: it may already have assigned the API, and killing it would kill the API too.
 */
export async function adoptWindowsApiJob(
  options: {
    dataDir?: string;
    targetPid?: number;
    expectedScript?: string;
    /** A provider host adopting itself: the API that started it, which the record must name. */
    controllerPid?: number;
  } = {},
): Promise<WindowsJobAdoption> {
  if (process.platform !== 'win32') return { adopted: false, reason: 'not_windows' };
  const targetPid = options.targetPid ?? process.pid;
  const expectedScript = basename(options.expectedScript ?? process.argv[1] ?? '');
  const dataDir = resolveCatCafeDataRoot(options.dataDir);
  const directory = resolveWindowsJobDirectory(dataDir);
  const jobName = `${options.controllerPid ? PROVIDER_JOB_NAME_PREFIX : JOB_NAME_PREFIX}${randomUUID()}`;
  const ownerRecordPath = join(directory, `${randomUUID()}.json`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  } catch (error) {
    return { adopted: false, reason: `job_directory_unavailable:${String(error)}` };
  }

  const script = jobOwnerScript({
    targetPid,
    expectedScript,
    jobName,
    ownerRecordPath,
    ...(options.controllerPid ? { controllerPid: options.controllerPid } : {}),
  });
  const helper = spawn('powershell.exe', powershellArgs(script), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  helper.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });
  const outcome = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('JOB_FAILED_TIMEOUT'), HELPER_TIMEOUT_MS);
    const finish = (value: string): void => {
      clearTimeout(timer);
      resolve(value);
    };
    helper.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(HELPER_READY)) finish(HELPER_READY);
      else if (stdout.includes('JOB_FAILED')) finish(stdout.trim().split('\n').pop() ?? 'JOB_FAILED');
    });
    helper.once('error', (error) => finish(`JOB_FAILED_SPAWN:${error.message}`));
    helper.once('exit', (code) => finish(stdout.includes(HELPER_READY) ? HELPER_READY : `JOB_FAILED_EXIT:${code}`));
  });

  // The helper outlives this call on purpose. Drop every reference it holds on this event loop — the
  // process and both pipes — so a finished API can still exit by itself. The pipes stay open:
  // closing them could fail a late helper write and end the job (and the API) early.
  helper.unref();
  if (helper.stdout instanceof Socket) helper.stdout.unref();
  if (helper.stderr instanceof Socket) helper.stderr.unref();

  const record = outcome === HELPER_READY ? readWindowsJobOwnerRecord(ownerRecordPath) : null;
  if (!record || record.jobName !== jobName || record.apiPid !== targetPid) {
    // Without a usable record no execution is ever linked to this job, so removing it is safe.
    rmSync(ownerRecordPath, { force: true });
    const reason = outcome === HELPER_READY ? 'owner_record_missing_after_ready' : outcome;
    return { adopted: false, reason: stderr.trim() ? `${reason}:${stderr.trim().slice(-500)}` : reason };
  }
  const job: WindowsApiJob = { record: { ...record, path: ownerRecordPath }, dataDir };
  if (targetPid === process.pid) currentApiJob = job;
  return { adopted: true, job };
}

export function readWindowsJobOwnerRecord(path: string): WindowsJobOwnerRecord | null {
  try {
    return parseWindowsJobOwnerRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Every durable owner record. Anything unreadable is reported, never read as "nothing there". */
export function readWindowsJobOwnerRecords(dataDir?: string): {
  records: WindowsJobOwnerEntry[];
  invalidPaths: string[];
} {
  const directory = resolveWindowsJobDirectory(dataDir);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], invalidPaths: [] };
    return { records: [], invalidPaths: [directory] };
  }
  const entries = names.map((name) => {
    const path = join(directory, name);
    return { path, record: readWindowsJobOwnerRecord(path) };
  });
  return {
    records: entries.flatMap(({ path, record }) => (record ? [{ ...record, path }] : [])),
    invalidPaths: entries.filter(({ record }) => !record).map(({ path }) => path),
  };
}

export function clearWindowsJobOwner(path: string): void {
  rmSync(path, { force: true });
}

export type WindowsJobQueryExecute = typeof execFileAsync;

/**
 * Query a recorded job from this (fresh) process.
 *
 * `absent` needs the exact native code AND the recording session: a `Local\` name resolves per
 * session, so from any other session a live job answers ERROR_FILE_NOT_FOUND too. Every other
 * outcome — present, another session, a failed or unparseable probe — keeps the execution protected.
 */
export async function queryWindowsJobStopEvidence(
  record: Pick<WindowsJobOwnerRecord, 'jobName' | 'sessionId'>,
  options: { execute?: WindowsJobQueryExecute } = {},
): Promise<WindowsJobStopEvidence> {
  const unknown = (reason: string): WindowsJobStopEvidence => ({ verdict: 'unknown', activeProcesses: 0, reason });
  const run = options.execute ?? execFileAsync;
  let parsed: unknown;
  try {
    const { stdout } = await run('powershell.exe', powershellArgs(jobQueryScript(record.jobName)), {
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '');
  } catch (error) {
    return unknown(error instanceof SyntaxError ? 'job_query_unparseable' : `job_query_failed:${String(error)}`);
  }
  const observed = asRecord(parsed);
  if (!observed) return unknown('job_query_unparseable');
  // A missing session can never equal the recorded one, so it reads as another session.
  if (observed.sessionId !== record.sessionId) {
    return unknown(`job_query_other_session:${String(observed.sessionId)}!=${record.sessionId}`);
  }
  if (observed.state === 'absent') {
    // A bare label, or any other native code, is not proof that the owner is gone.
    return observed.nativeError === 2
      ? { verdict: 'absent', activeProcesses: 0, reason: 'job_closed_owner_gone' }
      : unknown(`absent_without_error_file_not_found:${String(observed.nativeError)}`);
  }
  if (observed.state === 'present') {
    return isNonNegativeSafeInteger(observed.activeProcesses)
      ? { verdict: 'present', activeProcesses: observed.activeProcesses, reason: 'job_still_owns_members' }
      : { verdict: 'present', activeProcesses: 0, reason: 'job_present_count_unusable' };
  }
  return unknown(`job_query_error:${String(observed.nativeError ?? 'unknown')}`);
}

export type WindowsControllerVerdict = 'alive' | 'gone' | 'unknown';

/** One controller API exactly: pid alone could name a later process. */
export function windowsControllerKey(controller: { pid: number; createdAt: string }): string {
  return `${controller.pid}:${controller.createdAt}`;
}

/**
 * Whether each recorded controller API still exists. Only `gone` seen from the controller's own
 * session permits anything; a failed or unparseable probe, or another session, stays `unknown`.
 */
export async function queryWindowsControllers(
  controllers: ReadonlyArray<{ pid: number; createdAt: string; sessionId: number }>,
  options: { execute?: WindowsJobQueryExecute } = {},
): Promise<Map<string, WindowsControllerVerdict>> {
  const verdicts = new Map<string, WindowsControllerVerdict>(
    controllers.map((controller) => [windowsControllerKey(controller), 'unknown']),
  );
  if (controllers.length === 0) return verdicts;
  const run = options.execute ?? execFileAsync;
  let parsed: unknown;
  try {
    const { stdout } = await run('powershell.exe', powershellArgs(controllerQueryScript(controllers)), {
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '');
  } catch {
    return verdicts;
  }
  const observed = asRecord(parsed);
  const reported = asRecord(observed?.verdicts);
  if (!observed || !reported) return verdicts;
  for (const controller of controllers) {
    const key = windowsControllerKey(controller);
    const verdict = reported[key];
    // A process of another session may be invisible here, so its absence proves nothing.
    if (observed.sessionId === controller.sessionId && (verdict === 'alive' || verdict === 'gone'))
      verdicts.set(key, verdict);
  }
  return verdicts;
}
