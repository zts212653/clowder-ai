/** Preserve checkout-only originals; shared Git already owns tracked source. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { requireVisibleWorktreeIndex } from './worktree-light.mjs';
import { git, safeRealpath } from './worktree-reaper-probes.mjs';

export const RELEASE_ARCHIVES = '.worktree-release-archives';
const BUILT_PACKAGES = [
  'api',
  'web',
  'shared',
  'mcp-server',
  'collective-client',
  'collective-service',
  'collective-connector',
];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const generated = (path) =>
  /(^|\/)node_modules(\/|$)/.test(path) ||
  BUILT_PACKAGES.some((name) => path.startsWith(`packages/${name}/dist/`)) ||
  // sync-vendor-assets.mjs recreates these exact output families from installed dependencies.
  /^packages\/web\/public\/vendor\/(?:onnxruntime\/ort-wasm[^/]*\.(?:wasm|mjs)|esbuild\/esbuild\.wasm)$/.test(path) ||
  /^packages\/web\/\.next(?:\/|$|-test-[^/]+(?:\/|$))/.test(path) ||
  /^packages\/web\/tsconfig\.next-test-[^/]+\.json$/.test(path);

function mustGit(repo, args) {
  const result = git(repo, args);
  if (!result.ok) throw new Error(`archive git ${args[0]} refused`);
  return result.out.trim();
}

function hashFile(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function fingerprint(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return { kind: 'symlink', target: readlinkSync(path), bytes: 0 };
  if (!st.isFile()) throw new Error('archive original is not a regular file or symlink');
  return { kind: 'file', sha256: hashFile(path), bytes: st.size, mode: st.mode & 0o777 };
}

function safeChild(root, path) {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (
    !rel ||
    rel.startsWith('..') ||
    (!safeRealpath(dirname(abs)).startsWith(`${safeRealpath(root)}/`) &&
      safeRealpath(dirname(abs)) !== safeRealpath(root))
  )
    throw new Error('archive original path escapes root');
  return abs;
}

export function ignoredOriginals(path) {
  const result = git(path, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
    '--',
    '.',
    ':(exclude)node_modules',
    ':(exclude,glob)**/node_modules/**',
    ...BUILT_PACKAGES.map((name) => `:(exclude,glob)packages/${name}/dist/**`),
    ':(exclude,glob)packages/web/.next/**',
    ':(exclude,glob)packages/web/.next-test-*/**',
  ]);
  if (!result.ok) throw new Error('archive ignored original inventory unknown');
  return result.out
    .split('\0')
    .filter(Boolean)
    .filter((name) => !generated(name))
    .sort();
}

function copyOriginal(fromRoot, toRoot, name) {
  const from = safeChild(fromRoot, name);
  const to = safeChild(toRoot, name);
  const before = fingerprint(from);
  mkdirSync(dirname(to), { recursive: true });
  execFileSync('cp', ['-a', '--', from, to], { stdio: ['ignore', 'pipe', 'pipe'] });
  const copied = fingerprint(to);
  if (JSON.stringify(before) !== JSON.stringify(copied) || JSON.stringify(before) !== JSON.stringify(fingerprint(from)))
    throw new Error('archive original changed or verification failed');
  return { path: name, ...before };
}

function metadataFiles(root, prefix = '') {
  const files = [];
  for (const name of readdirSync(join(root, prefix))) {
    const rel = join(prefix, name);
    const st = lstatSync(join(root, rel));
    if (st.isDirectory()) files.push(...metadataFiles(root, rel));
    else files.push(rel);
  }
  return files.sort();
}

function directoryModes(root, names) {
  const dirs = new Set(['']);
  for (const name of names) {
    for (let parent = dirname(name); parent !== '.'; parent = dirname(parent)) dirs.add(parent);
  }
  return [...dirs].sort().map((path) => ({ path, mode: lstatSync(path ? safeChild(root, path) : root).mode & 0o777 }));
}

function applyDirectoryModes(root, modes) {
  for (const { path, mode } of [...modes].reverse()) chmodSync(path ? safeChild(root, path) : root, mode);
}

export function createReleaseArchive({ repo, entry, archivePath, txn }) {
  requireVisibleWorktreeIndex(entry.path);
  const root = dirname(archivePath);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw new Error('archive root is a symlink');
  if (lstatSync(root).uid !== process.getuid?.()) throw new Error('archive root owner mismatch');
  chmodSync(root, 0o700);
  mkdirSync(archivePath, { mode: 0o700 });
  mkdirSync(join(archivePath, 'files'));
  mkdirSync(join(archivePath, 'git-metadata'));
  const originals = ignoredOriginals(entry.path).map((name) =>
    copyOriginal(entry.path, join(archivePath, 'files'), name),
  );
  const originalDirectories = directoryModes(
    entry.path,
    originals.map((item) => item.path),
  );
  applyDirectoryModes(join(archivePath, 'files'), originalDirectories);
  const gitDir = mustGit(entry.path, ['rev-parse', '--absolute-git-dir']);
  const common = safeRealpath(mustGit(entry.path, ['rev-parse', '--git-common-dir']));
  if (gitDir === common || !safeRealpath(gitDir).startsWith(`${common}/worktrees/`))
    throw new Error('archive private Git metadata boundary unknown');
  const metadata = metadataFiles(gitDir).map((name) => copyOriginal(gitDir, join(archivePath, 'git-metadata'), name));
  const metadataDirectories = directoryModes(
    gitDir,
    metadata.map((item) => item.path),
  );
  applyDirectoryModes(join(archivePath, 'git-metadata'), metadataDirectories);
  const reflog = mustGit(entry.path, ['reflog', 'show', '--format=%H', 'HEAD']);
  const privateRefs = mustGit(entry.path, [
    'for-each-ref',
    '--format=%(objectname)',
    'refs/worktree',
    'refs/bisect',
    'refs/rewritten',
  ]);
  const objects = [...new Set([entry.head, ...reflog.split('\n'), ...privateRefs.split('\n')].filter(Boolean))];
  const pinnedRefs = [];
  for (const head of objects) {
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('archive reflog object unknown');
    const ref = `refs/catcafe-releases/${txn}/${head}`;
    mustGit(repo, ['update-ref', ref, head]);
    pinnedRefs.push({ ref, head });
  }
  const manifest = {
    v: 1,
    repo,
    path: entry.originalPath ?? entry.path,
    removedPath: entry.path,
    owner: entry.lifecycle.owner,
    sourceRef: entry.finishSourceRef,
    head: entry.head,
    ...(entry.mergedAt ? { mergedAt: entry.mergedAt } : {}),
    ...(entry.mergedPr ? { mergedPr: entry.mergedPr } : {}),
    branch: entry.branch,
    originals,
    originalDirectories,
    metadata,
    metadataDirectories,
    pinnedRefs,
  };
  writeFileSync(join(archivePath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestSha256: hashFile(join(archivePath, 'manifest.json')) };
}

export function verifyReleaseArchive(archivePath, expectedSha256, expectedRepo) {
  if (safeRealpath(archivePath) !== archivePath || !existsSync(join(archivePath, 'manifest.json')))
    throw new Error('release archive missing or relocated');
  if (hashFile(join(archivePath, 'manifest.json')) !== expectedSha256)
    throw new Error('release archive manifest changed');
  const manifest = JSON.parse(readFileSync(join(archivePath, 'manifest.json'), 'utf8'));
  if (manifest.repo !== expectedRepo) throw new Error('release archive repository mismatch');
  for (const [subdir, records] of [
    ['files', manifest.originals],
    ['git-metadata', manifest.metadata],
  ]) {
    for (const { path, ...expected } of records) {
      if (JSON.stringify(fingerprint(safeChild(join(archivePath, subdir), path))) !== JSON.stringify(expected))
        throw new Error('release archive original verification failed');
    }
  }
  for (const [subdir, modes] of [
    ['files', manifest.originalDirectories],
    ['git-metadata', manifest.metadataDirectories],
  ]) {
    const names = modes.filter((item) => item.path).map((item) => join(item.path, 'placeholder'));
    if (JSON.stringify(directoryModes(join(archivePath, subdir), names)) !== JSON.stringify(modes))
      throw new Error('release archive directory permissions changed');
  }
  for (const { ref, head } of manifest.pinnedRefs) {
    if (mustGit(manifest.repo, ['rev-parse', '--verify', ref]) !== head)
      throw new Error('release archive Git history missing');
    mustGit(manifest.repo, ['cat-file', '-e', head]);
  }
  mustGit(manifest.repo, ['cat-file', '-e', `${manifest.head}^{commit}`]);
  return manifest;
}

export function verifySourceOriginals(entry, manifest) {
  requireVisibleWorktreeIndex(entry.path);
  const names = ignoredOriginals(entry.path);
  if (JSON.stringify(names) !== JSON.stringify(manifest.originals.map((item) => item.path)))
    throw new Error('ignored originals changed before removal');
  for (const { path, ...expected } of manifest.originals) {
    if (JSON.stringify(fingerprint(safeChild(entry.path, path))) !== JSON.stringify(expected))
      throw new Error('ignored original changed before removal');
  }
  if (JSON.stringify(directoryModes(entry.path, names)) !== JSON.stringify(manifest.originalDirectories))
    throw new Error('original directory permissions changed before removal');
}

export function releaseRestoreCommand(repo, entry, archivePath) {
  const path = entry.originalPath ?? entry.path;
  const config = join(archivePath, 'git-metadata/config.worktree');
  const sparse = join(archivePath, 'git-metadata/info/sparse-checkout');
  const gitPath = (name) => `"$(git -C ${quote(path)} rev-parse --git-path ${name})"`;
  return (
    `git -C ${quote(repo)} worktree add --detach --no-checkout ${quote(path)} ${quote(entry.head)} && ` +
    `cp -P ${quote(config)} ${gitPath('config.worktree')} && ` +
    `(if [ -f ${quote(sparse)} ]; then mkdir -p "$(git -C ${quote(path)} rev-parse --absolute-git-dir)/info" && cp -P ${quote(sparse)} ${gitPath('info/sparse-checkout')}; fi) && ` +
    `git -C ${quote(path)} read-tree -mu HEAD && cp -a ${quote(join(archivePath, 'files'))}/. ${quote(path)}/`
  );
}
