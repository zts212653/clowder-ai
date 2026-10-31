#!/usr/bin/env node
/**
 * Create a worktree with a declared lifecycle — the "birth" half of the reaper contract, and the one
 * creation entry cats use.
 *
 *   pnpm worktree:new ../cat-cafe-f999-x --branch feat/f999-x                  # owner=$CAT_CAFE_CAT_ID, policy=merged
 *   pnpm worktree:new ../cat-cafe-review-x --branch review/x --policy ttl --ttl-days 7
 *   pnpm worktree:new <path> --declare-only --owner opus5 --policy never        # declare an existing one
 *
 * Policies: merged (default; quarantined 7 idle days after its content reached origin/main), ttl
 * (--ttl-days N), never. The declaration lives in the worktree's own config (`git config --worktree`,
 * requires extensions.worktreeConfig) or, for a standalone clone, its `--local` config — never the shared
 * repository config.
 *
 * Order: validate everything (declaration, worktreeConfig, base) → `git worktree add` → declaration; if the
 * declaration fails, the new worktree and branch are removed again so nothing half-created is left behind.
 */
import { fileURLToPath } from 'node:url';
import { deferredMedia, initializeLightCheckout } from './lib/worktree-light.mjs';
import { originFromEnvironment, validateOrigin } from './lib/worktree-origin.mjs';
import { LIFECYCLE_POLICIES } from './lib/worktree-reaper-core.mjs';
import { checkoutKind, git } from './lib/worktree-reaper-probes.mjs';
import { mainRepoFrom } from './worktree-reaper.mjs';

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function mustGit(cwd, args, what) {
  const res = git(cwd, args);
  if (!res.ok) throw new Error(`${what} failed: git ${args.join(' ')}`);
  return res.out;
}

/** Throws `invalid …` for a declaration worktree-new would refuse to write. Touches nothing. */
export function validateDeclaration({ owner, policy, ttlDays }) {
  if (typeof owner !== 'string' || owner.trim() === '') {
    throw new Error('invalid --owner: required (your catId; defaults to $CAT_CAFE_CAT_ID)');
  }
  if (!LIFECYCLE_POLICIES.includes(policy)) {
    throw new Error(`invalid --policy ${policy}: ${LIFECYCLE_POLICIES.join('|')}`);
  }
  if (policy === 'ttl' && !(Number.isInteger(ttlDays) && ttlDays >= 1)) {
    throw new Error('invalid --ttl-days: policy=ttl needs an integer >= 1');
  }
}

function worktreeConfigEnabled(dir) {
  return git(dir, ['config', '--bool', 'extensions.worktreeConfig']).out.trim() === 'true';
}

/** Write catcafe.lifecycle.* for an existing worktree or clone. */
export function declareLifecycle(dir, { owner, policy, ttlDays, now = Date.now(), origin }) {
  validateDeclaration({ owner, policy, ttlDays });
  validateOrigin(origin);
  const scope = checkoutKind(dir) === 'clone' ? '--local' : '--worktree';
  if (scope === '--worktree' && !worktreeConfigEnabled(dir)) {
    throw new Error('extensions.worktreeConfig is not enabled; refusing to write a shared-config declaration');
  }
  const set = (key, value) => mustGit(dir, ['config', scope, `catcafe.lifecycle.${key}`, value], 'declare');
  set('owner', owner);
  set('policy', policy);
  set('createdAt', new Date(now).toISOString());
  if (origin) set('origin', JSON.stringify(origin));
  if (policy === 'ttl') set('expiresAt', new Date(now + ttlDays * 86_400_000).toISOString());
}

/** Validate → `git worktree add` → declaration (rolled back if it fails). No numeric veto or cleanup. */
export function createWorktree({
  repo,
  path,
  branch,
  base = 'origin/main',
  owner,
  policy = 'merged',
  ttlDays,
  now,
  full = false,
  declare = declareLifecycle,
  origin,
}) {
  validateDeclaration({ owner, policy, ttlDays });
  validateOrigin(origin);
  if (!worktreeConfigEnabled(repo)) {
    throw new Error('extensions.worktreeConfig is not enabled; run `git config extensions.worktreeConfig true` once');
  }
  if (!git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).ok) {
    throw new Error(`invalid --base ${base}: not a commit in this repository (fetch it first?)`);
  }
  const deferred = full ? null : deferredMedia(repo, base);
  mustGit(
    repo,
    ['worktree', 'add', ...(full ? [] : ['--no-checkout']), path, ...(branch ? ['-b', branch] : []), base],
    'worktree add',
  );
  try {
    if (deferred) initializeLightCheckout(path, deferred);
    declare(path, { owner, policy, ttlDays, now, origin });
  } catch (err) {
    // Fresh and clean by construction: remove without --force (anything unexpected makes git refuse).
    const removed = git(repo, ['worktree', 'remove', path]).ok;
    if (removed && branch) git(repo, ['branch', '-D', branch]); // created just now by `-b`, holds no commits
    err.message += removed ? ' (the new worktree was rolled back)' : ` (rollback failed: remove ${path} by hand)`;
    throw err;
  }
}

function main(argv) {
  const path = argv[0];
  if (!path || path.startsWith('--')) {
    throw new Error('usage: worktree-new <path> --branch <name> [--owner <catId>] [--policy merged|ttl|never]');
  }
  const ttlRaw = flag(argv, '--ttl-days');
  const decl = {
    owner: flag(argv, '--owner') ?? process.env.CAT_CAFE_CAT_ID,
    policy: flag(argv, '--policy') ?? 'merged',
    origin: originFromEnvironment(process.env, {
      threadId: flag(argv, '--thread-id'),
      sourceRef: flag(argv, '--source-ref'),
      role: flag(argv, '--role'),
      userId: flag(argv, '--user-id'),
    }),
    ttlDays: ttlRaw === undefined ? undefined : Number(ttlRaw),
  };
  if (argv.includes('--declare-only')) {
    declareLifecycle(path, decl);
  } else {
    const repo = mainRepoFrom(process.cwd());
    createWorktree({
      repo,
      path,
      branch: flag(argv, '--branch'),
      base: flag(argv, '--base'),
      full: argv.includes('--full'),
      ...decl,
    });
  }
  console.log(`[worktree-new] ${path} declared owner=${decl.owner} policy=${decl.policy}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`[worktree-new] ${err.message}`);
    process.exitCode = err.exitCode ?? 64;
  }
}
