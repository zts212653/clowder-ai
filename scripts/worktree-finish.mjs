#!/usr/bin/env node
/** Explicitly finish one owned checkout: reversible release or bounded named retention. */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireNoDurableConsumers } from './lib/worktree-consumers.mjs';
import { directReleaseReceipt, removeFinishedWorktree } from './lib/worktree-direct-release.mjs';
import { requireVisibleWorktreeIndex } from './lib/worktree-light.mjs';
import { parsePrSource, readPrTruth } from './lib/worktree-pr.mjs';
import { quarantineRoot, readQuarantineRecords } from './lib/worktree-quarantine.mjs';
import { isProtected, LIFECYCLE_POLICIES, parseWorktreePorcelain } from './lib/worktree-reaper-core.mjs';
import {
  busyProcess,
  git,
  isAncestor,
  isContainedIn,
  lifecycleConfig,
  processRefs,
  safeRealpath,
  statusFacts,
} from './lib/worktree-reaper-probes.mjs';
import { MAX_RETENTION_MS, retentionStatus } from './lib/worktree-retention.mjs';
import { mainRepoFrom } from './worktree-reaper.mjs';

const fail = (reason) => {
  throw new Error(reason);
};
function mustGit(repo, args) {
  const result = git(repo, args);
  if (!result.ok) fail(`git ${args[0]} refused`);
  return result.out.trim();
}

export function ownedWorktreeFacts(opts) {
  const records = parseWorktreePorcelain(mustGit(opts.repo, ['worktree', 'list', '--porcelain']));
  const record = records.find((r) => safeRealpath(r.path) === opts.path);
  if (!record || record.prunable) fail('target is not a registered worktree');
  if (
    opts.path === safeRealpath(records[0].path) ||
    isProtected(basename(opts.path), undefined, basename(records[0].path))
  )
    fail('protected/main worktree');
  const root = quarantineRoot(dirname(safeRealpath(records[0].path)));
  if (opts.path.startsWith(`${root}/`)) fail('target is already in quarantine');
  const lifecycle = lifecycleConfig(opts.path, '--worktree');
  const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s));
  if (
    !lifecycle ||
    !LIFECYCLE_POLICIES.includes(lifecycle.policy) ||
    !validDate(lifecycle.createdAt) ||
    (lifecycle.policy === 'ttl' && !validDate(lifecycle.expiresAt))
  )
    fail('incomplete lifecycle declaration');
  if (lifecycle.owner !== opts.owner) fail('owner mismatch');
  if (mustGit(opts.path, ['config', '--bool', 'extensions.worktreeConfig']) !== 'true')
    fail('private worktree config required');
  return { ...record, path: opts.path, name: basename(opts.path), kind: 'worktree', registered: true, lifecycle, root };
}

function verifyRetention(entry, opts) {
  const status = retentionStatus(entry.lifecycle, opts.now);
  if (status !== 'retained-until') fail(status ?? 'no retained disposition');
  const retention = entry.lifecycle.retention;
  if (retention.sourceRef !== opts.sourceRef) fail('retention source mismatch');
  if (retention.head !== entry.head) fail('retention head changed');
  return {
    state: 'retained',
    path: entry.path,
    owner: opts.owner,
    sourceRef: opts.sourceRef,
    head: entry.head,
    reason: retention.reason,
    until: retention.until,
  };
}

function verifyRelease(opts) {
  const root = quarantineRoot(dirname(safeRealpath(opts.repo)));
  const direct = directReleaseReceipt({ ...opts, root });
  if (direct) return direct;
  const valid = readQuarantineRecords(root);
  let lines;
  try {
    lines = readFileSync(join(root, 'ledger.jsonl'), 'utf8').trim().split('\n');
  } catch {
    fail('no completed release receipt');
  }
  const records = parseWorktreePorcelain(mustGit(opts.repo, ['worktree', 'list', '--porcelain']));
  for (const line of lines.reverse()) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      r.from !== opts.path ||
      r.state !== 'done' ||
      !valid.has(r.to) ||
      r.owner !== opts.owner ||
      r.sourceRef !== opts.sourceRef
    )
      continue;
    const actual = records.find((w) => safeRealpath(w.path) === safeRealpath(r.to));
    if (!actual || actual.prunable || actual.head !== r.head || !existsSync(r.to)) continue;
    return {
      state: 'released',
      storageDisposition: 'quarantined',
      path: opts.path,
      owner: opts.owner,
      sourceRef: opts.sourceRef,
      head: r.head,
      quarantinePath: r.to,
      restore: r.restore,
    };
  }
  fail('no matching completed release receipt');
}

function requireCleanTarget(path) {
  const status = statusFacts(path);
  if (status.trackedChanges === null || status.untrackedPreserved === null) fail('status unknown');
  if (status.trackedChanges || status.untrackedPreserved)
    fail('dirty worktree: preserve/commit authored files, or retain with a deadline');
}

function requireMergedContent(entry, opts) {
  if (opts.prTruth) {
    if (!opts.prTruth.commits.includes(entry.head)) fail('PR does not contain the exact checkout HEAD');
    if (isAncestor(opts.repo, opts.mergedAt, 'origin/main') !== true)
      fail('PR merge commit must be in origin/main history; fetch before finishing');
    return;
  }
  if (entry.lifecycle.policy !== 'merged') {
    if (opts.mergedAt) fail('merged-at requires a merged-policy worktree');
    return;
  }
  if (opts.mergedAt && isAncestor(opts.repo, opts.mergedAt, 'origin/main') !== true)
    fail('merged-at must be a commit in origin/main history');
  if (isContainedIn(opts.repo, entry.head, opts.mergedAt ?? 'origin/main') !== true)
    fail('not-merged or ancestry unknown; fetch origin/main or retain');
}

function releaseProbe(entry, opts) {
  if (opts.expectedHead !== undefined && entry.head !== opts.expectedHead) fail('checkout HEAD changed');
  opts.releaseGuard?.(entry);
  if (entry.locked) fail('locked worktree');
  if (entry.lifecycle.policy === 'never') fail('policy-never: change owner intent explicitly first');
  if (retentionStatus(entry.lifecycle, opts.now) === 'retention-invalid') fail('invalid owner retention');
  if (entry.lifecycle.retention && entry.lifecycle.retention.sourceRef !== opts.sourceRef)
    fail('retention source mismatch');
  const cwd = safeRealpath(process.cwd());
  if (cwd === entry.path || cwd.startsWith(`${entry.path}/`)) fail('busy: run finish from outside the target worktree');
  const refs = opts.cwdProbe ? opts.cwdProbe() : processRefs({ excludePids: [process.pid], observerPid: process.pid });
  const busy = busyProcess(entry.path, refs);
  if (busy === null) fail('process state unknown');
  if (busy)
    fail(
      `busy worktree: ${busy.kind} pid=${busy.pid ?? 'unknown'}${busy.executable ? ` executable=${busy.executable}` : ''}`,
    );
  requireNoDurableConsumers(opts);
  requireVisibleWorktreeIndex(entry.path);
  requireCleanTarget(entry.path);
  requireMergedContent(entry, opts);
}

function retainWorktree(initial, opts) {
  if (typeof opts.until !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(opts.until))
    fail('invalid until: ISO deadline requires an explicit timezone');
  if (Date.parse(opts.until) - opts.now > MAX_RETENTION_MS) fail('invalid until: maximum retention is 30 days');
  const retention = {
    owner: opts.owner,
    sourceRef: opts.sourceRef,
    head: initial.head,
    reason: opts.reason,
    until: opts.until,
    recordedAt: new Date(opts.now).toISOString(),
  };
  if (retentionStatus({ ...initial.lifecycle, retention }, opts.now) !== 'retained-until')
    fail('invalid reason/until: named retention needs a future ISO deadline');
  retention.until = new Date(Date.parse(retention.until)).toISOString();
  mustGit(opts.path, ['config', '--worktree', 'catcafe.lifecycle.retention', JSON.stringify(retention)]);
  return verifyRetention(ownedWorktreeFacts(opts), opts);
}

function resolveMergedPr(opts) {
  if (opts.mergedPr !== undefined) {
    parsePrSource(opts.mergedPr);
    if (opts.mode !== 'release' || opts.mergedAt !== undefined)
      fail('merged PR requires exact PR truth and release mode; cannot combine with merged-at');
    const truth = (opts.readPr ?? readPrTruth)(opts.mergedPr);
    if (
      truth.sourceRef !== opts.mergedPr ||
      truth.state !== 'MERGED' ||
      !/^[0-9a-f]{40}$/.test(truth.mergedAt ?? '') ||
      !Array.isArray(truth.commits) ||
      !truth.commits.length ||
      !truth.commits.every((sha) => /^[0-9a-f]{40}$/.test(sha))
    )
      fail('merged PR truth unavailable or invalid');
    opts.prTruth = truth;
    opts.mergedAt = truth.mergedAt;
  }
}

/** No batch deletion, no branch deletion, no --force, no mutation while checking. */
export function finishWorktree(input) {
  const opts = {
    mode: 'release',
    now: Date.now(),
    ...input,
    path: safeRealpath(resolve(input.path)),
    repo: safeRealpath(input.repo),
  };
  for (const key of ['owner', 'sourceRef']) {
    if (typeof opts[key] !== 'string' || !opts[key].trim() || opts[key].length > 2000 || /[\r\n\0]/.test(opts[key]))
      fail(`required ${key}`);
  }
  if (!['release', 'retain', 'check'].includes(opts.mode)) fail('invalid disposition mode');
  resolveMergedPr(opts);
  if (
    opts.mergedAt !== undefined &&
    (opts.mode !== 'release' || typeof opts.mergedAt !== 'string' || !/^[0-9a-f]{40}$/.test(opts.mergedAt))
  )
    fail('merged-at requires an exact 40-character commit SHA and release mode');
  if (opts.mode === 'check' && !existsSync(opts.path)) return verifyRelease(opts);
  const initial = ownedWorktreeFacts(opts);
  if (opts.mode === 'check') return verifyRetention(initial, opts);
  if (opts.mode === 'retain') return retainWorktree(initial, opts);
  releaseProbe(initial, opts);
  const current = ownedWorktreeFacts(opts);
  releaseProbe(current, opts);
  if (initial.head !== current.head || JSON.stringify(initial.lifecycle) !== JSON.stringify(current.lifecycle))
    fail('worktree changed before release');
  removeFinishedWorktree({
    repo: opts.repo,
    actor: opts.actor ?? opts.owner,
    authorizationRef: opts.authorizationRef ?? opts.sourceRef,
    root: current.root,
    entry: {
      ...current,
      reason: 'owner-finished',
      finishSourceRef: opts.sourceRef,
      mergedAt: opts.mergedAt,
      mergedPr: opts.mergedPr,
    },
    validate: () => {
      const final = ownedWorktreeFacts(opts);
      releaseProbe(final, opts);
      if (final.head !== current.head || JSON.stringify(final.lifecycle) !== JSON.stringify(current.lifecycle))
        fail('worktree changed before removal');
    },
  });
  if (existsSync(opts.path)) fail('release not verified: original path still exists');
  return verifyRelease(opts);
}

function optionValue(flags, flag, value) {
  const key = flags[flag];
  if (!key || value === undefined || value.startsWith('--')) fail(`invalid flag/value: ${flag}`);
  return { [key]: value };
}

export function parseFinishArgs(argv, env = process.env) {
  const path = argv[0];
  if (!path || path.startsWith('--'))
    fail(
      'usage: worktree-finish <path> --source-ref <task/pr/message> [--merged-at <commit>] [--retain --reason <why> --until <ISO>] [--check]',
    );
  const opts = { path, owner: env.CAT_CAFE_CAT_ID, mode: 'release' };
  const flags = {
    '--owner': 'owner',
    '--source-ref': 'sourceRef',
    '--reason': 'reason',
    '--until': 'until',
    '--merged-at': 'mergedAt',
    '--merged-pr': 'mergedPr',
  };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--retain' || flag === '--check') {
      if (opts.mode !== 'release') fail('choose one disposition mode');
      opts.mode = flag === '--retain' ? 'retain' : 'check';
    } else {
      Object.assign(opts, optionValue(flags, flag, argv[++i]));
    }
  }
  if (env.CAT_CAFE_CAT_ID && opts.owner !== env.CAT_CAFE_CAT_ID) fail('owner differs from runtime identity');
  return opts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = finishWorktree({ ...parseFinishArgs(process.argv.slice(2)), repo: mainRepoFrom(process.cwd()) });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      JSON.stringify({
        state: 'blocked',
        reason: error.message,
        ...(error.recovery ? { recovery: error.recovery } : {}),
      }),
    );
    process.exitCode = 1;
  }
}
