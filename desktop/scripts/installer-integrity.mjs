import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Release installers must not carry a restrictive mandatory integrity label
 * inherited from the build directory.
 *
 * Two failure modes were observed on this build host:
 *  1. A Low-labelled Setup is launched at Low integrity. Inno Setup cannot
 *     create its `%TEMP%\is-*.tmp` staging directory (error 5: access denied)
 *     and dies before any installer code runs.
 *  2. An explicitly Medium-labelled Setup caps the Setup process at Medium
 *     integrity instead of the elevated High token, so the `PrepareToInstall`
 *     identity helper (PowerShell `Add-Type`) fails with Win32 1314
 *     "a required privilege is not held by the client".
 *
 * A normal build (no mandatory label, inherited from a default Medium folder)
 * and an explicit High label both launch with the caller token: the elevated
 * installer reaches High and can create its temp directory and compile the
 * identity helper. This module fails closed when a release EXE is still
 * unlaunchable.
 */

const LABEL_PATTERN = /Mandatory Label\\([^:\r\n]+)/i;

export function readMandatoryLabel(filePath) {
  if (process.platform !== 'win32') return { supported: false, level: 'unsupported', raw: '' };
  if (!fs.existsSync(filePath)) throw new Error(`Cannot read integrity label: missing file ${filePath}`);
  const result = spawnSync('icacls.exe', [filePath], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`icacls failed for ${filePath}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = output.match(LABEL_PATTERN);
  // icacls only prints a mandatory label when the object has an explicit or
  // inherited label. A file without that line has no label and launches with
  // the caller token (normal behaviour).
  const level = match ? normalizeLevel(match[1]) : 'Medium';
  return { supported: true, level, raw: match ? match[0].trim() : '' };
}

function normalizeLevel(label) {
  const normalized = String(label)
    .trim()
    .replace(/\s+Mandatory Level$/i, '')
    .trim();
  return normalized || 'Unknown';
}

function setHigh(filePath) {
  const result = spawnSync('icacls.exe', [filePath, '/setintegritylevel', 'High'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `icacls /setintegritylevel High failed for ${filePath}: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
}

/**
 * A release artifact is launchable when it has no mandatory label (normal
 * build) or an explicit High label. Low or explicitly Medium/other labels cap
 * the elevated Setup process and break TEMP creation or the identity helper.
 */
export function isReleaseBlocking(label) {
  if (!label.supported) return false;
  if (!label.raw) return false;
  return label.level !== 'High';
}

/**
 * Ensure a release artifact can launch elevated with its caller token. Returns
 * before/after labels and whether the label was changed. Throws when the label
 * is still blocking, so a release build never reports success for an
 * unlaunchable installer.
 */
export function ensureReleaseIntegrity(filePath, { relabel = true } = {}) {
  const before = readMandatoryLabel(filePath);
  if (!before.supported) return { ...before, before: before.level, changed: false };
  if (!isReleaseBlocking(before)) return { ...before, before: before.level, after: before.level, changed: false };
  if (!relabel) return { ...before, before: before.level, after: before.level, changed: false };
  setHigh(filePath);
  const after = readMandatoryLabel(filePath);
  if (isReleaseBlocking(after)) {
    throw new Error(
      `Release artifact ${filePath} is still ${after.level} integrity after relabel; ` +
        'deliver it from a default Medium directory or raise it to High manually before release',
    );
  }
  return { ...before, before: before.level, after: after.level, changed: true };
}

function parseArgs(argv) {
  const options = { file: undefined, json: false, check: false, copyTo: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--copy-to') options.copyTo = argv[++index];
    else if (arg?.startsWith('--copy-to=')) options.copyTo = arg.slice('--copy-to='.length);
    else if (!options.file) options.file = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.file)
    throw new Error('Usage: node installer-integrity.mjs <installer.exe> [--json] [--check] [--copy-to <dir>]');
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = path.resolve(options.file);
  let target = source;
  if (options.copyTo) {
    const destinationDir = path.resolve(options.copyTo);
    fs.mkdirSync(destinationDir, { recursive: true });
    target = path.join(destinationDir, path.basename(source));
    fs.copyFileSync(source, target);
  }
  const outcome = ensureReleaseIntegrity(target, { relabel: !options.check });
  const ok = !outcome.supported || !isReleaseBlocking(readMandatoryLabel(target));
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ path: target, ...outcome, ok })}\n`);
  } else if (!outcome.supported) {
    process.stdout.write('Integrity labels are only enforced on Windows.\n');
  } else if (outcome.changed) {
    process.stdout.write(`Raised ${target} from ${outcome.before} to ${outcome.after} integrity.\n`);
  } else {
    process.stdout.write(`${target} integrity: ${outcome.after}\n`);
  }
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
