/** Branch-local materialization of large historical docs attachments. No shared writable assets. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from './worktree-reaper-probes.mjs';

const MEDIA = /^docs\/.*\.(?:png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav|ogg|pdf|zip|gz|tgz|tar|7z)$/i;
const LITERAL_PATH = /^[A-Za-z0-9_./-]+$/;
const MIN_BYTES = 512 * 1024;

function run(repo, args, input) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function referencedDocs(repo, revision) {
  const result = git(repo, [
    'grep',
    '-I',
    '-h',
    '-e',
    'docs/',
    revision,
    '--',
    'packages',
    'scripts',
    'sync-manifest.yaml',
  ]);
  if (!result.ok && result.code !== 1) throw new Error('cannot inspect docs consumers');
  const files = (result.out.match(/docs\/[A-Za-z0-9_./-]+/g) ?? []).filter((name) => MEDIA.test(name));
  const runtime = git(repo, ['grep', '-I', '-h', '-e', 'docs/', revision, '--', 'packages/api/src']);
  if (!runtime.ok && runtime.code !== 1) throw new Error('cannot inspect runtime docs directories');
  // Keep explicit runtime directory readers too. Generic workspace/docs browsers
  // and synthetic test directories do not require the entire historical archive.
  const dirs = [...runtime.out.matchAll(/["'`](docs\/[A-Za-z0-9_-]+\/[A-Za-z0-9_/-]+)["'`]/g)].map((match) => match[1]);
  return [...new Set([...files, ...dirs])];
}

export function deferredMedia(repo, revision) {
  const refs = referencedDocs(repo, revision);
  return run(repo, ['ls-tree', '-r', '-l', '-z', revision, '--', 'docs'])
    .split('\0')
    .filter(Boolean)
    .flatMap((row) => {
      const match = /^(\d+) blob [a-f0-9]+\s+(\d+)\t(.+)$/s.exec(row);
      if (!match) return [];
      const [, mode, bytes, name] = match;
      if (mode !== '100644' || Number(bytes) < MIN_BYTES || !MEDIA.test(name) || !LITERAL_PATH.test(name)) return [];
      return refs.some((ref) => name === ref || name.startsWith(`${ref.replace(/\/$/, '')}/`)) ? [] : [name];
    });
}

function setDeferred(repo, names) {
  // Exact negative patterns: newly added branch files stay visible automatically.
  run(repo, ['sparse-checkout', 'set', '--no-cone', '--stdin'], `/*\n${names.map((name) => `!/${name}\n`).join('')}`);
  run(repo, ['config', '--worktree', 'catcafe.checkout.mode', 'light-v1']);
}

export function initializeLightCheckout(repo, names) {
  if (names.length) setDeferred(repo, names);
  run(repo, ['read-tree', '-mu', 'HEAD']);
}

/** null means unmanaged: never interpret arbitrary skip-worktree flags as safe. */
export function managedDeferredPaths(repo) {
  if (git(repo, ['config', '--worktree', '--get', 'catcafe.checkout.mode']).out.trim() !== 'light-v1') return null;
  if (git(repo, ['config', '--bool', 'core.sparseCheckout']).out.trim() !== 'true') return null;
  const rules = readFileSync(run(repo, ['rev-parse', '--git-path', 'info/sparse-checkout']).trim(), 'utf8')
    .trimEnd()
    .split('\n');
  if (rules.shift() !== '/*') throw new Error('managed sparse rules changed; preserve and inspect the worktree');
  return new Set(
    rules.map((line) => {
      if (!line.startsWith('!/') || !LITERAL_PATH.test(line.slice(2)))
        throw new Error('managed sparse rule is not an exact path');
      return line.slice(2);
    }),
  );
}

export function requireVisibleWorktreeIndex(repo) {
  const flags = run(repo, ['ls-files', '-v', '-z']).split('\0').filter(Boolean);
  const deferred = managedDeferredPaths(repo);
  for (const row of flags) {
    if (
      /^[a-z] /.test(row) ||
      (row.startsWith('S ') && (!deferred?.has(row.slice(2)) || existsSync(join(repo, row.slice(2)))))
    )
      throw new Error('hidden index flags: retain or explicitly restore normal source visibility before finish');
  }
}

export function materializeAssets(repo, paths, { all = false } = {}) {
  const deferred = managedDeferredPaths(repo);
  if (!deferred) throw new Error('worktree is not a managed light checkout');
  if (all) {
    run(repo, ['sparse-checkout', 'disable']);
    run(repo, ['config', '--worktree', '--unset', 'catcafe.checkout.mode']);
    return { state: 'full', materialized: [...deferred] };
  }
  if (!paths.length) return { state: 'light', deferred: [...deferred] };
  for (const name of paths) {
    if (
      !name ||
      name.startsWith('/') ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      /[\r\n\0]/.test(name)
    )
      throw new Error('assets path must be relative to the worktree');
  }
  const selected = [...deferred].filter((name) =>
    paths.some((path) => name === path || name.startsWith(`${path.replace(/\/$/, '')}/`)),
  );
  for (const name of paths) {
    if (!run(repo, ['ls-files', '-z', '--', `:(literal)${name.replace(/\/$/, '')}`]))
      throw new Error(`no tracked assets at ${name}`);
  }
  setDeferred(
    repo,
    [...deferred].filter((name) => !selected.includes(name)),
  );
  return { state: 'light', materialized: selected };
}

export function worktreeRoot(cwd) {
  return resolve(run(cwd, ['rev-parse', '--show-toplevel']).trim());
}
