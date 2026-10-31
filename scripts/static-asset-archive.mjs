#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Original avatar sources are an archive, separate from public/avatars. Do not
// generalize this to assets/: prompt inputs, generators and SVG can execute.
export function isStaticArchivePath(name) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject Git path control bytes rather than split them into apparently safe paths.
  return /^assets\/avatars\/[^./\\\x00-\x1f\x7f][^/\\\x00-\x1f\x7f]*\.png$/u.test(name);
}

// This is a format sanity check, not a replacement for the author's image
// decoding, visual/source check and user selection. No approval flag is minted.
function hasPngStructure(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false;
  let offset = 8;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) return false;
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) return false;
    if (type === 'IDAT') imageData = true;
    offset += length + 12;
    if (type === 'IEND') return length === 0 && imageData && offset === bytes.length;
  }
  return false;
}

function git(repoRoot, args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function collectWorkingChangePaths({ repoRoot = process.cwd(), base = 'origin/main', runGit } = {}) {
  const queries = [
    ['diff', '--name-only', '-z', `${base}...HEAD`],
    ['diff', '--name-only', '-z'],
    ['diff', '--name-only', '--cached', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ];
  return [
    ...new Set(queries.flatMap((args) => (runGit ? runGit(args) : git(repoRoot, args)).split('\0').filter(Boolean))),
  ].sort();
}

function hasValidStagedImage(repoRoot, name) {
  const entries = git(repoRoot, ['ls-files', '--stage', '-z', '--', name]).split('\0').filter(Boolean);
  if (entries.length === 0) return true; // An untracked addition is checked from the worktree below.
  if (entries.length !== 1) return false;
  const [mode, blob, stage] = entries[0].split('\t')[0].split(' ');
  return mode === '100644' && stage === '0' && hasPngStructure(git(repoRoot, ['cat-file', 'blob', blob], null));
}

function hasValidCommittedImage(repoRoot, name) {
  const entries = git(repoRoot, ['ls-tree', '-z', 'HEAD', '--', name]).split('\0').filter(Boolean);
  if (entries.length === 0) return true; // Staged/untracked additions have no committed object yet.
  if (entries.length !== 1) return false;
  const [mode, type, blob] = entries[0].split('\t')[0].split(' ');
  return mode === '100644' && type === 'blob' && hasPngStructure(git(repoRoot, ['cat-file', 'blob', blob], null));
}

export function isWorkingStaticArchive({ repoRoot = process.cwd(), base = 'origin/main', changedFiles }) {
  if (!changedFiles?.length || !changedFiles.every(isStaticArchivePath)) return false;
  try {
    const actual = collectWorkingChangePaths({ repoRoot, base });
    if (JSON.stringify(actual) !== JSON.stringify([...new Set(changedFiles)].sort())) return false;
    return changedFiles.every((name) => {
      if (git(repoRoot, ['ls-tree', '-z', base, '--', name])) return false;
      if (!hasValidCommittedImage(repoRoot, name)) return false;
      if (!hasValidStagedImage(repoRoot, name)) return false;
      const file = path.join(repoRoot, name);
      const stat = lstatSync(file);
      return (
        stat.isFile() &&
        stat.size <= 32 * 1024 * 1024 &&
        (stat.mode & 0o111) === 0 &&
        realpathSync(file) === path.join(realpathSync(repoRoot), name) &&
        hasPngStructure(readFileSync(file))
      );
    });
  } catch {
    return false; // Missing/ambiguous repository evidence cannot authorize a lane.
  }
}

export function isCommittedStaticArchive({ repoRoot = process.cwd(), base, head }) {
  if (![base, head].every((ref) => /^[0-9a-f]{40}$/u.test(ref ?? ''))) return false;
  try {
    const fields = git(repoRoot, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', base, head, '--']).split('\0');
    fields.pop();
    if (fields.length === 0 || fields.length % 2 !== 0) return false;
    for (let index = 0; index < fields.length; index += 2) {
      const metadata = fields[index].split(' ');
      const name = fields[index + 1];
      if (
        metadata.length !== 5 ||
        metadata[0] !== ':000000' ||
        metadata[1] !== '100644' ||
        metadata[4] !== 'A' ||
        !isStaticArchivePath(name)
      )
        return false;
      if (!hasPngStructure(git(repoRoot, ['cat-file', 'blob', metadata[3]], null))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [base, head, ...extra] = process.argv.slice(2);
  process.exitCode = extra.length === 0 && isCommittedStaticArchive({ base, head }) ? 0 : 1;
}
