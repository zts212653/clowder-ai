#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const directory = valueAfter(args, '--dir');
const output = valueAfter(args, '--output');
const stage = valueAfter(args, '--stage') || null;
const runId = valueAfter(args, '--run-id') || null;
if (!directory || !output) {
  throw new Error('usage: finalize-test-file-timing --dir DIR --output FILE [--stage STAGE --run-id ID]');
}

const reports = [];
if (existsSync(directory)) {
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json'))) {
    const reportPath = path.join(directory, name);
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      if (report?.schemaVersion !== 1 || !Array.isArray(report.files)) continue;
      reports.push({
        path: reportPath,
        runner: report.runner || 'unknown',
        pid: report.pid ?? null,
        files: report.files,
      });
    } catch {
      // Each reporter writes atomically; ignore a sidecar that was not complete.
    }
  }
}

const files = reports
  .flatMap((report) =>
    report.files.map((file) => ({
      ...file,
      runner: file.runner || report.runner,
      processId: report.pid,
      reportPath: report.path,
    })),
  )
  .filter((file) => typeof file.file === 'string' && Number.isFinite(file.durationMs) && file.durationMs >= 0)
  .sort((left, right) => right.durationMs - left.durationMs || left.file.localeCompare(right.file));

const artifact = {
  schemaVersion: 1,
  kind: 'gate-test-file-timing',
  stage,
  runId,
  generatedAt: new Date().toISOString(),
  reportCount: reports.length,
  fileCount: files.length,
  totalFileDurationMs: files.reduce((total, file) => total + file.durationMs, 0),
  files,
};
mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
const temporaryPath = `${output}.${process.pid}.tmp`;
try {
  writeFileSync(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporaryPath, output);
} finally {
  rmSync(temporaryPath, { force: true });
}
process.stdout.write(`${JSON.stringify({ output, reportCount: reports.length, fileCount: files.length })}\n`);
