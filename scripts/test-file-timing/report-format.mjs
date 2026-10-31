import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const TEST_FILE_TIMING_SCHEMA_VERSION = 1;

function asFiniteDuration(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null;
}

export function timingEnvironment(environment = process.env) {
  const directory = environment.CAT_CAFE_TEST_TIMING_DIR;
  if (typeof directory !== 'string' || directory.length === 0) return null;
  return {
    directory,
    repoRoot: environment.CAT_CAFE_TEST_TIMING_REPO_ROOT || process.cwd(),
    stage: environment.CAT_CAFE_TEST_TIMING_STAGE || null,
  };
}

export function normalizeTestFile(file, repoRoot = process.cwd()) {
  if (typeof file !== 'string' || file.length === 0) return null;
  let value = file;
  if (value.startsWith('file://')) {
    try {
      value = new URL(value).pathname;
    } catch {
      // Keep the original opaque module id below.
    }
  }
  const absolute = path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
  if (relative && relative !== '..' && !relative.startsWith('../')) return relative;
  return value.split(path.sep).join('/');
}

export function normalizeFileTiming(file, repoRoot, runner, extra = {}) {
  const durationMs = asFiniteDuration(file.durationMs);
  if (!file.file || durationMs === null) return null;
  const diagnostics = Object.fromEntries(
    ['setupDurationMs', 'collectDurationMs']
      .map((key) => [key, asFiniteDuration(file[key])])
      .filter(([, value]) => value !== null),
  );
  return {
    file: normalizeTestFile(file.file, repoRoot),
    durationMs,
    runner,
    status: file.status || 'unknown',
    ...diagnostics,
    ...extra,
  };
}

export function writeTimingReport({ runner, files, environment = process.env, metadata = {} }) {
  const timing = timingEnvironment(environment);
  if (!timing) return null;
  mkdirSync(timing.directory, { recursive: true, mode: 0o700 });
  const report = {
    schemaVersion: TEST_FILE_TIMING_SCHEMA_VERSION,
    runner,
    pid: process.pid,
    stage: timing.stage,
    generatedAt: new Date().toISOString(),
    files: files
      .map((file) => normalizeFileTiming(file, timing.repoRoot, runner))
      .filter(Boolean)
      .sort((left, right) => left.file.localeCompare(right.file) || left.durationMs - right.durationMs),
    ...metadata,
  };
  const reportPath = path.join(timing.directory, `${runner.replaceAll(':', '-')}-${process.pid}-${randomUUID()}.json`);
  const temporaryPath = `${reportPath}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(report)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, reportPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return reportPath;
}
