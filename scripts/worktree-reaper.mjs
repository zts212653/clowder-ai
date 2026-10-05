#!/usr/bin/env node
/**
 * Worktree reaper — gives "retire a checkout copy" the same system status as "create one".
 *
 *   pnpm worktree:reap                  # dry-run: classify everything, write .cat-cafe/tmp/reaper-<date>.tsv
 *   pnpm worktree:reap --apply          # quarantine declared+eligible dirs (moves, never deletes)
 *   pnpm worktree:reap --purge          # delete quarantine entries older than 14 days (only deleting path)
 *   pnpm worktree:check                 # exit 2 when active declared worktrees >= cap (40); legacy not counted
 *
 * Who triggers what: nothing runs on a schedule and creation never moves anything. `--apply` (quarantine)
 * and `--purge` (the only deletion) are explicit commands, run by whoever is authorised to.
 *
 * Only directories whose owner declared a lifecycle at birth (scripts/worktree-new.mjs) are acted on;
 * everything else is reported. Decision rules: scripts/lib/worktree-reaper-core.mjs.
 * Background: accumulated checkout copies (130+ worktrees plus stray clones) kept macOS fseventsd
 * under sustained pressure; the contract in scripts/lib/worktree-reaper-core.mjs explains why
 * removal is declaration-gated and reversible.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  moveToQuarantine,
  purgeQuarantined,
  quarantineRoot,
  readQuarantineRecords,
} from './lib/worktree-quarantine.mjs';
import {
  classifyEntry,
  classifyQuarantined,
  DEFAULT_POLICY,
  isProtected,
  parseWorktreePorcelain,
} from './lib/worktree-reaper-core.mjs';
import {
  checkoutKind,
  diskKb,
  git,
  idleDays,
  isBusy,
  isContainedIn,
  isHollow,
  lastGitActivityMs,
  lifecycleConfig,
  processRefs,
  safeRealpath,
  statusFacts,
} from './lib/worktree-reaper-probes.mjs';
import { riskNotes } from './lib/worktree-reaper-risk.mjs';

const DEFAULT_SANDBOX_ROOTS = ['/tmp/cat-cafe-review'];

function registeredWorktrees(repo) {
  const res = git(repo, ['worktree', 'list', '--porcelain']);
  if (!res.ok) throw new Error(`git worktree list failed in ${repo}`);
  return parseWorktreePorcelain(res.out);
}

function childDirs(dir, filter = () => true) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && filter(d.name))
      .map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

/** Enumerate candidates without probing them: registered worktrees, siblings, sandboxes, quarantine. */
function describe({ repo, parentDir, sandboxRoots = DEFAULT_SANDBOX_ROOTS }) {
  const records = registeredWorktrees(repo);
  const mainPath = safeRealpath(records[0]?.path ?? repo);
  const parent = safeRealpath(parentDir ?? dirname(mainPath));
  const qroot = quarantineRoot(parent);
  const inQuarantine = (p) => p.startsWith(`${qroot}/`);
  const descs = [];
  const registered = new Set();
  for (const r of records) {
    const path = safeRealpath(r.path);
    registered.add(path);
    if (r.prunable) continue; // directory already gone; `git worktree prune` handles the metadata
    const isMain = path === mainPath;
    const kind = isMain || dirname(path) === parent ? 'worktree' : 'sandbox';
    descs.push({ path, name: basename(path), kind, isMain, registered: true, locked: r.locked, head: r.head });
  }
  const loose = [
    ...childDirs(parent, (n) => n.startsWith('cat-cafe-')),
    ...sandboxRoots.map(safeRealpath).flatMap((root) => childDirs(root)),
    ...childDirs(qroot).flatMap((day) => childDirs(day)),
  ];
  for (const p of loose) {
    const path = safeRealpath(p);
    if (registered.has(path)) continue;
    const ck = checkoutKind(path);
    const kind = ck === 'clone' ? 'clone' : 'orphan';
    descs.push({ path, name: basename(path), kind, isMain: false, registered: false, locked: false, checkout: ck });
  }
  const ledger = readQuarantineRecords(qroot);
  return { descs: descs.map((d) => ({ ...d, quarantined: inQuarantine(d.path), ledger })), qroot };
}

/**
 * Quarantine time comes only from a completed ledger record, never from the (renameable) directory.
 * Status + git activity show whether anyone worked in it after the move (then it is no longer purgeable).
 */
function quarantineFacts(d) {
  const isCheckout = d.registered || d.checkout === 'clone';
  return {
    quarantinedAt: d.ledger.get(d.path) ?? null,
    ...(isCheckout ? statusFacts(d.path) : { trackedChanges: null, untrackedPreserved: null }),
    lastActivityMs: isCheckout ? lastGitActivityMs(d.path) : null,
    // The CURRENT declaration: an owner may say `never` (or re-declare) after the move.
    lifecycle: isCheckout ? lifecycleConfig(d.path, d.registered ? '--worktree' : '--local') : null,
  };
}

/** Probe one described candidate. */
function probe(d, { refs, now, originRef, repo }) {
  const base = { ...d, busy: isBusy(d.path, refs) };
  if (d.isMain) return base;
  if (d.quarantined) return { ...base, ...quarantineFacts(d) };
  if (d.kind === 'orphan') {
    return { ...base, empty: d.checkout === 'plain' ? isHollow(d.path) : d.checkout === 'remnant' ? false : null };
  }
  const isClone = d.kind === 'clone';
  return {
    ...base,
    ...statusFacts(d.path),
    idleDays: idleDays(d.path, now),
    lifecycle: lifecycleConfig(d.path, isClone ? '--local' : '--worktree'),
    // A clone is judged against its own origin/main; a worktree against the shared object store.
    // "In main" means its content is (ancestry, or a squash/rebase merge whose tree main already holds).
    inMain: isClone ? isContainedIn(d.path, 'HEAD', originRef) : isContainedIn(repo, d.head, originRef),
  };
}

/** Gather facts for every candidate. */
export function collectEntries(opts) {
  const { now = Date.now(), cwdProbe = processRefs, originRef = 'origin/main' } = opts;
  const { descs, qroot } = describe(opts);
  const ctx = { refs: cwdProbe(), now, originRef, repo: opts.repo };
  return descs.map((d) => probe({ ...d, qroot }, ctx));
}

export function planReap(entries, policy = DEFAULT_POLICY, now = Date.now()) {
  return entries.map((e) => ({
    ...e,
    ...(e.quarantined ? classifyQuarantined(e, policy, now) : classifyEntry(e, policy, now)),
  }));
}

/** Re-probe one entry right before acting (the plan may be minutes old). */
function recheck(entry, opts, policy) {
  const now = opts.now ?? Date.now();
  const { descs, qroot } = describe(opts);
  const d = descs.find((x) => x.path === entry.path);
  if (!d) return null;
  const ctx = {
    refs: (opts.cwdProbe ?? processRefs)(),
    now,
    originRef: opts.originRef ?? 'origin/main',
    repo: opts.repo,
  };
  return planReap([probe({ ...d, qroot }, ctx)], policy, now)[0];
}

function runActions(plan, opts, policy, verdict, act) {
  const results = [];
  for (const planned of plan.filter((e) => e.verdict === verdict)) {
    const e = recheck(planned, opts, policy);
    if (!e || e.verdict !== verdict) {
      results.push({
        name: planned.name,
        path: planned.path,
        outcome: 'skipped',
        detail: `changed: ${e?.reason ?? 'gone'}`,
      });
      continue;
    }
    try {
      results.push({ name: e.name, path: e.path, outcome: act(e) });
    } catch (err) {
      results.push({ name: e.name, path: e.path, outcome: 'failed', detail: err.message });
    }
  }
  return results;
}

/** Quarantine eligible declared dirs. Never deletes anything. */
export function applyReap(plan, opts, policy = DEFAULT_POLICY) {
  const root = quarantineRoot(safeRealpath(opts.parentDir ?? dirname(safeRealpath(opts.repo))));
  // A live wall clock, read per move (never the batch-start `now`): each ledger time is when that move happened.
  const clock = opts.clock ?? Date.now;
  const results = runActions(plan, opts, policy, 'quarantine', (e) => {
    moveToQuarantine({ repo: opts.repo, root, entry: e, clock });
    return 'quarantined';
  });
  // `git worktree move` keeps metadata consistent; nothing to prune, and a no-op call must not touch the repo.
  return results;
}

/** Delete quarantine entries past the restore window. The only deleting action. */
export function purgeReap(plan, opts, policy = DEFAULT_POLICY) {
  const root = quarantineRoot(safeRealpath(opts.parentDir ?? dirname(safeRealpath(opts.repo))));
  const results = runActions(plan, opts, policy, 'purge', (e) => {
    purgeQuarantined({ repo: opts.repo, root, entry: e });
    return 'purged';
  });
  git(opts.repo, ['worktree', 'prune']);
  return results;
}

/**
 * Worktrees that hold a creation slot: registered, not main, not in quarantine, not whitelisted, and
 * declared at birth (an unreadable declaration counts too — the gate fails closed). Undeclared worktrees
 * predate the contract; they are returned separately as `legacy` inventory, which is a maintainer's one-time
 * job, not something a cat starting a new task should have to clear.
 */
export function capacityHolders({ repo, parentDir, policy = DEFAULT_POLICY }) {
  const records = registeredWorktrees(repo);
  const mainPath = safeRealpath(records[0]?.path ?? repo);
  const qroot = quarantineRoot(safeRealpath(parentDir ?? dirname(mainPath)));
  const active = [];
  const legacy = [];
  for (const r of records) {
    const path = safeRealpath(r.path);
    const name = basename(path);
    if (r.prunable || path === mainPath || path.startsWith(`${qroot}/`)) continue;
    if (isProtected(name, policy)) continue;
    const lifecycle = lifecycleConfig(path, '--worktree');
    if (lifecycle !== null && !lifecycle.policy) legacy.push({ path, name });
    else active.push({ path, name, owner: lifecycle?.owner ?? '?' });
  }
  return { active, legacy };
}

export function checkCapacity({ repo, parentDir, max = DEFAULT_POLICY.maxWorktrees }) {
  const { active, legacy } = capacityHolders({ repo, parentDir });
  // Checked BEFORE `git worktree add`: at the cap, the next one would be over.
  return { count: active.length, max, over: active.length >= max, legacy: legacy.length };
}

function writeLedger(repo, plan, withSizes) {
  const dir = join(repo, '.cat-cafe', 'tmp');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `reaper-${new Date().toISOString().slice(0, 10)}.tsv`);
  const rows = plan.map((e) => {
    const acted = e.verdict !== 'keep';
    const kb = withSizes && acted ? diskKb(e.path) : null;
    const risk = acted && !e.quarantined && e.kind !== 'orphan' ? riskNotes(e.path) : '';
    return [e.path, e.kind, e.verdict, e.reason, kb === null ? '' : String(kb * 1024), risk].join('\t');
  });
  writeFileSync(file, `${['path', 'kind', 'verdict', 'reason', 'bytes', 'risk'].join('\t')}\n${rows.join('\n')}\n`);
  return file;
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export function parsePolicyArgs(args) {
  // Idle/quarantine windows are safety axes; a flag on the same command as --apply/--purge could both
  // weaken and use them. Only the creation cap (which never moves or deletes anything) is tunable.
  for (const locked of ['--min-idle-days', '--quarantine-days']) {
    if (args.includes(locked)) throw new Error(`invalid ${locked}: this safety window is not configurable`);
  }
  if (!args.includes('--max')) return { ...DEFAULT_POLICY };
  const raw = argValue(args, '--max');
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`invalid --max ${raw ?? '(missing)'}: expected an integer >= 1`);
  }
  return { ...DEFAULT_POLICY, maxWorktrees: Number(raw) };
}

export function mainRepoFrom(cwd) {
  const res = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!res.ok) throw new Error('not inside a git repository');
  return dirname(res.out.trim());
}

function report(results) {
  for (const r of results) console.log(`  ${r.outcome.padEnd(11)} ${r.path}${r.detail ? ` (${r.detail})` : ''}`);
  return results.some((r) => r.outcome === 'failed') ? 1 : 0;
}

function main(argv) {
  const repo = argValue(argv, '--repo') ?? mainRepoFrom(process.cwd());
  const policy = parsePolicyArgs(argv);
  if (argv.includes('--check')) {
    const cap = checkCapacity({ repo, max: policy.maxWorktrees });
    const legacy = cap.legacy > 0 ? ` (+${cap.legacy} undeclared legacy, not counted)` : '';
    if (!cap.over) {
      console.log(`[worktree-reaper] OK ${cap.count}/${cap.max} active declared worktrees${legacy}`);
      return 0;
    }
    console.error(
      `[worktree-reaper] FULL ${cap.count}/${cap.max} active declared worktrees${legacy} — ` +
        '`pnpm worktree:new` will refuse and list who holds the slots.',
    );
    return 2;
  }
  const opts = { repo };
  const plan = planReap(collectEntries(opts), policy);
  const ledger = writeLedger(repo, plan, !argv.includes('--no-sizes'));
  const tally = {};
  for (const e of plan) tally[e.verdict] = (tally[e.verdict] ?? 0) + 1;
  console.log(`[worktree-reaper] ${JSON.stringify(tally)} ledger=${ledger}`);
  for (const e of plan.filter((x) => x.verdict !== 'keep'))
    console.log(`  ${e.verdict.padEnd(12)} ${e.reason.padEnd(22)} ${e.path}`);
  let code = 0;
  if (argv.includes('--apply')) code = Math.max(code, report(applyReap(plan, opts, policy)));
  if (argv.includes('--purge')) code = Math.max(code, report(purgeReap(plan, opts, policy)));
  if (!argv.includes('--apply') && !argv.includes('--purge')) console.log('[worktree-reaper] dry-run; nothing moved.');
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`[worktree-reaper] ${err.message}`);
    process.exitCode = 64; // usage / environment error: nothing was classified or moved
  }
}
