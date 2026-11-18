/** Shared creation/materialization for developer worktrees and Alpha. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyCloneCandidates, supportsApfsClone } from './worktree-clone.mjs';
import { deferredMedia, initializeLightCheckout } from './worktree-light.mjs';
import { git } from './worktree-reaper-probes.mjs';

function run(repo, args, input) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', repo, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function tree(repo) {
  return run(repo, ['ls-tree', '-r', '-z', 'HEAD'])
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf('\t');
      const [mode, type, oid] = row.slice(0, tab).split(' ');
      return { mode, type, oid, name: row.slice(tab + 1) };
    });
}

function convertedPaths(repo, names) {
  const converted = new Set();
  const attributes = run(repo, ['check-attr', '--cached', '-z', '--all', '--stdin'], `${names.join('\0')}\0`).split(
    '\0',
  );
  for (let i = 0; i + 2 < attributes.length; i += 3) {
    if (['filter', 'text', 'eol', 'crlf', 'ident', 'working-tree-encoding'].includes(attributes[i + 1]))
      converted.add(attributes[i]);
  }
  return converted;
}

function populateClonedCheckout(repo, path, { cloneBatch } = {}) {
  // Build a fresh target index. Never import source stat data or visibility flags.
  run(path, ['read-tree', 'HEAD']);
  const target = tree(path);
  const source = new Map(tree(repo).map((file) => [file.name, file]));
  const converted = convertedPaths(
    path,
    target.map((file) => file.name),
  );
  const autocrlf = git(path, ['config', '--get', 'core.autocrlf']).out.trim();
  const crlf = (autocrlf && autocrlf !== 'false') || git(path, ['config', '--get', 'core.eol']).out.trim() === 'crlf';
  const candidates = target
    .filter((file) => {
      if (
        crlf ||
        !/^100(?:644|755)$/.test(file.mode) ||
        source.get(file.name)?.oid !== file.oid ||
        file.name === '.gitattributes' ||
        file.name.endsWith('/.gitattributes') ||
        converted.has(file.name)
      )
        return false;
      try {
        return lstatSync(join(repo, file.name)).isFile();
      } catch {
        return false;
      }
    })
    .map((file) => ({ ...file, source: join(repo, file.name), destination: join(path, file.name) }));
  copyCloneCandidates(candidates, cloneBatch);
  const cloned = new Set();
  for (const file of candidates) {
    let regular;
    try {
      regular = lstatSync(file.destination).isFile();
    } catch {
      regular = false;
    }
    if (!regular) continue;
    chmodSync(file.destination, (file.mode === '100755' ? 0o777 : 0o666) & ~process.umask());
    cloned.add(file.name);
  }
  const remaining = target.filter((file) => !cloned.has(file.name));
  const ordinary = remaining.filter((file) => file.type !== 'commit');
  // Submodules stay uninitialized, as with ordinary worktree add.
  for (const file of remaining.filter((file) => file.type === 'commit'))
    mkdirSync(join(path, file.name), { recursive: true });
  if (ordinary.length)
    run(path, ['checkout-index', '-f', '-z', '--stdin'], `${ordinary.map((file) => file.name).join('\0')}\0`);
  // Refresh hashes every landed clone once and caches clean stat information. Only mismatches
  // (including dirty/raced/partial copies) are replaced; verified clones are never checked out.
  run(path, ['update-index', '-q', '--refresh']);
  const changed = run(path, ['diff-files', '--name-only', '-z']).split('\0').filter(Boolean);
  if (changed.length) {
    run(path, ['checkout-index', '-f', '-z', '--stdin'], `${changed.join('\0')}\0`);
    for (const name of changed) cloned.delete(name);
  }
  run(path, ['update-index', '--refresh']);
  return { strategy: 'clone', clonedFiles: cloned.size, checkedOutFiles: target.length - cloned.size };
}

function cloneSource(repo, path, supportsClone) {
  if (!supportsClone && process.platform !== 'darwin') return null;
  // Use the already-supported common-dir resolver; no Git 2.36 registry flags on any path.
  const source = dirname(run(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  if (!(supportsClone ?? supportsApfsClone)(source, path)) return null;
  if (git(repo, ['config', '--bool', 'core.sparseCheckout']).out.trim() !== 'true') return source;
  if (git(repo, ['config', '--bool', 'extensions.worktreeConfig']).out.trim() !== 'true') return null;
  return source;
}

function populateCheckout(repo, path, source, full, checkoutOptions) {
  if (source) {
    // Disable inherited exclusions only in the new private config, before copying anything.
    if (git(path, ['config', '--bool', 'core.sparseCheckout']).out.trim() === 'true')
      run(path, ['config', '--worktree', 'core.sparseCheckout', 'false']);
    return populateClonedCheckout(source, path, checkoutOptions);
  }
  if (!full) initializeLightCheckout(path, deferredMedia(repo, run(path, ['rev-parse', 'HEAD']).trim()));
  return { strategy: 'git', clonedFiles: 0 };
}

export function createCheckout({
  repo,
  path,
  branch,
  base = 'origin/main',
  full = false,
  checkoutOptions = {},
  afterCheckout,
}) {
  repo = resolve(repo);
  path = resolve(path);
  mkdirSync(dirname(path), { recursive: true });
  const source = cloneSource(repo, existsSync(path) ? path : dirname(path), checkoutOptions.supportsClone);
  const noCheckout = Boolean(source) || !full;
  run(repo, [
    'worktree',
    'add',
    ...(noCheckout ? ['--no-checkout'] : []),
    ...(branch ? ['-b', branch] : []),
    path,
    base,
  ]);
  let result;
  let materialized = !noCheckout;
  try {
    result = populateCheckout(repo, path, source, full, checkoutOptions);
    materialized = true;
    afterCheckout?.();
  } catch (err) {
    // Only this just-created no-checkout tree can lack a valid index. No hooks have run yet.
    // After materialization, preserve unexpected work instead of forcing its removal.
    const removed = git(repo, ['worktree', 'remove', ...(!materialized ? ['--force'] : []), path]).ok;
    if (removed && branch) git(repo, ['branch', '-D', branch]);
    err.message += removed
      ? ' (the new worktree was rolled back)'
      : ` (rollback failed: preserve ${path} for inspection)`;
    throw err;
  }
  if (full && source) {
    // Preserve full worktree add's post-checkout hook without overwriting clones. A hook can
    // commit work; its failure must preserve the checkout/branch, outside fresh-checkout rollback.
    const head = run(path, ['rev-parse', 'HEAD']).trim();
    run(path, ['hook', 'run', '--ignore-missing', 'post-checkout', '--', '0'.repeat(head.length), head, '1']);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [repo, path, base, branch] = process.argv.slice(2);
  try {
    if (!repo || !path || !base) throw new Error('usage: worktree-checkout <repo> <path> <base> [new-branch]');
    console.log(`[worktree-checkout] ${JSON.stringify(createCheckout({ repo, path, base, branch, full: true }))}`);
  } catch (error) {
    console.error(`[worktree-checkout] ${error.message}`);
    process.exitCode = 1;
  }
}
