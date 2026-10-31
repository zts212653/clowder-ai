import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCatCafeDataRoot } from '../../utils/cli-process-ownership.js';
import { codexBinaryFingerprint, readCodexNativeVersion } from './native-version.js';
import {
  CODEX_COMPAT_PROBE_REVISION,
  type CodexCompatReport,
  type CodexNativeCapability,
  probeCodexNativeCapability,
} from './probe.js';

/**
 * Admission of an installed Codex for a capability = a recorded, passing, credential-free measurement
 * of that exact version. A new version is measured once on first use (no hard-coded version list);
 * the verdict is kept per version without TTL. A failure only admits nothing: it is remembered for
 * the same installed files for FAILURE_RETRY_MS (so launches do not re-run the probe back to back) and
 * measured again at once when the install changes, e.g. when an upgrade that was caught half-way
 * finishes swapping its files.
 */
const FAILURE_RETRY_MS = 2 * 60_000;
const DIRECTORY = 'codex-native-compat';
type Probe = typeof probeCodexNativeCapability;
let probe: Probe = probeCodexNativeCapability;
const inflight = new Map<string, Promise<CodexCompatReport>>();
const recentFailures = new Map<string, { report: CodexCompatReport; at: number }>();

export function codexCompatVerdictPath(capability: CodexNativeCapability, version: string, dataRoot: string): string {
  return join(dataRoot, DIRECTORY, `${capability}--${version.replace(/[^0-9A-Za-z.-]/g, '_')}.json`);
}

async function readPassingVerdict(path: string, capability: CodexNativeCapability, version: string) {
  try {
    const report = JSON.parse(await readFile(path, 'utf8')) as CodexCompatReport;
    return report.ok === true &&
      report.capability === capability &&
      report.version === version &&
      report.probeRevision === CODEX_COMPAT_PROBE_REVISION
      ? report
      : undefined;
  } catch {
    return undefined;
  }
}

async function persist(path: string, report: CodexCompatReport): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function codexNativeCapabilityVerdict(
  binary: string,
  capability: CodexNativeCapability,
  version: string,
  dataRoot = resolveCatCafeDataRoot(),
): Promise<CodexCompatReport> {
  const path = codexCompatVerdictPath(capability, version, dataRoot);
  const recorded = await readPassingVerdict(path, capability, version);
  if (recorded) return recorded;
  const key = `${capability}|${version}|${path}`;
  const failureKey = `${key}|${codexBinaryFingerprint(binary)}`;
  const failure = recentFailures.get(failureKey);
  if (failure && Date.now() - failure.at < FAILURE_RETRY_MS) return failure.report;
  const running = inflight.get(key);
  if (running) return running;
  const measured = probe(binary, capability, version)
    .then(async (report) => {
      // Failing reports are written too, as the evidence a human reads; only passing ones admit.
      await persist(path, report).catch(() => {});
      if (!report.ok) recentFailures.set(failureKey, { report, at: Date.now() });
      return report;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, measured);
  return measured;
}

/** Throws `<errorCode>:<version>:<first failed check>` unless this version measured compatible. */
export async function admitCodexNativeCapability(
  binary: string,
  capability: CodexNativeCapability,
  env: NodeJS.ProcessEnv,
  errorCode: string,
): Promise<string> {
  const version = await readCodexNativeVersion(binary, env);
  const report = await codexNativeCapabilityVerdict(binary, capability, version);
  if (!report.ok) {
    const failed = report.checks.find((entry) => !entry.ok)?.id ?? 'probe.completed';
    throw new Error(`${errorCode}:${version}:${failed}`);
  }
  return version;
}

/** Test seams only. */
export function setCodexNativeProbeForTest(replacement: Probe | undefined): void {
  probe = replacement ?? probeCodexNativeCapability;
  inflight.clear();
  recentFailures.clear();
}
