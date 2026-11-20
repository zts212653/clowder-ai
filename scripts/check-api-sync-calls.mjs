#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNewApiSyncCalls, isApiProductionSource } from './lib/api-sync-calls.mjs';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function sourceAt(root, ref, file) {
  const entry = git(root, ['ls-tree', ref, '--', file]);
  if (!entry) return '';
  if (!/^100(?:644|755) blob /u.test(entry)) throw new Error(`Unsupported source entry: ${file}`);
  return git(root, ['show', `${ref}:${file}`]);
}

function workingSource(root, file) {
  const path = resolve(root, file);
  if (!lstatSync(path).isFile()) throw new Error(`Unsupported working source: ${file}`);
  const sourceRoot = realpathSync(resolve(root, 'packages/api/src'));
  if (!realpathSync(path).startsWith(`${sourceRoot}${sep}`)) throw new Error(`Source escapes API root: ${file}`);
  return readFileSync(path, 'utf8');
}

function indexSource(root, file) {
  const entry = git(root, ['ls-files', '--stage', '-z', '--', file]);
  if (!/^100(?:644|755) [a-f0-9]+ 0\t/u.test(entry)) throw new Error(`Unsupported index source: ${file}`);
  return git(root, ['show', `:${file}`]);
}

function revision(root, ref) {
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
}

function selectedInputs(root, { staged, base }) {
  const head = revision(root, 'HEAD');
  if (staged)
    return {
      before: head,
      files: git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z', '--', 'packages/api/src/']),
      read: (file) => indexSource(root, file),
    };
  if (base) {
    const before = git(root, ['merge-base', head, revision(root, base)]).trim();
    return {
      before,
      files: git(root, ['diff', '--name-only', '--diff-filter=ACMRT', '-z', before, head, '--', 'packages/api/src/']),
      read: (file) => sourceAt(root, head, file),
    };
  }
  let before = head;
  try {
    before = git(root, ['merge-base', head, revision(root, 'origin/main')]).trim();
  } catch {
    // An isolated local fixture may have no remote. Its existing HEAD is the debt baseline.
  }
  return {
    before,
    files:
      git(root, ['diff', '--name-only', '--diff-filter=ACMRT', '-z', before, '--', 'packages/api/src/']) +
      git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'packages/api/src/']),
    read: (file) => workingSource(root, file),
  };
}

export function checkApiSyncCalls(root, options = {}) {
  const input = selectedInputs(root, options);
  const files = [...new Set(input.files.split('\0').filter(isApiProductionSource))];
  const findings = files.flatMap((file) =>
    findNewApiSyncCalls(file, sourceAt(root, input.before, file), input.read(file)),
  );
  return { files: files.length, base: input.before, findings };
}

function main() {
  try {
    const args = process.argv.slice(2);
    const staged = args.length === 1 && args[0] === '--staged';
    const base = args.length === 2 && args[0] === '--base' ? args[1] : undefined;
    if (args.length && !staged && !base) throw new Error('Usage: check-api-sync-calls [--staged | --base <revision>]');
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    const result = checkApiSyncCalls(root, { staged, base });
    for (const finding of result.findings)
      console.error(`${finding.file}:${finding.line}: new synchronous ${finding.method} call on API source`);
    console.log(`[api-sync-calls] ${result.findings.length ? 'FAIL' : 'PASS'}: ${result.files} changed source files`);
    if (result.findings.length) {
      console.error(
        'Use asynchronous process APIs or a reviewed dedicated child entry. Existing call-site debt is preserved.',
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[api-sync-calls] unable to scan: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 2;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
