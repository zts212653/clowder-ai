/**
 * Pure decision core for scripts/worktree-reaper.mjs.
 *
 * Why this exists (2026-09-17): Clowder AI had a creation path for every
 * kind of checkout copy (feature worktrees, review sandboxes, daily eval clones) and no system
 * path for removing them. 130 worktrees + 36 unregistered directories accumulated; every
 * install/checkout inside them fed macOS fseventsd, which reached 15-17 GB RSS.
 *
 * Contract (after three review rounds showed "prove the directory holds no user state"
 * is an open enumeration that can never be completed):
 * - Ownership is declared at birth (`catcafe.lifecycle.*` in the worktree/clone-local git config,
 *   written by scripts/worktree-new.mjs). Undeclared directories are only ever reported.
 * - The automatic action is QUARANTINE (move aside, restorable), not deletion. Only `--purge`
 *   deletes, and only quarantine entries older than `quarantineDays`.
 * - No exceptions: an undeclared directory — even a hollow one — is only reported.
 * - A fact that could not be determined is a third state → review, never folded into a pass.
 */

export const DEFAULT_POLICY = Object.freeze({
  /** Directory basenames that are never touched, whatever their state or declaration. */
  whitelist: Object.freeze([
    'cat-cafe',
    'cat-cafe-runtime',
    'cat-cafe-alpha',
    'cat-cafe-tutorials',
    'cat-cafe-sharing',
    'cat-cafe-recovery-backups',
  ]),
  /** Any basename with one of these prefixes is also protected (e.g. future runtime variants). */
  protectedPrefixes: Object.freeze(['cat-cafe-runtime']),
  /** policy=merged: days without activity after the branch reached origin/main. */
  mergedIdleDays: 7,
  /** Days a quarantined directory stays restorable before --purge may delete it. */
  quarantineDays: 14,
  maxWorktrees: 40,
});

export const LIFECYCLE_POLICIES = Object.freeze(['merged', 'ttl', 'never']);

const keep = (reason) => ({ verdict: 'keep', reason });
const review = (reason) => ({ verdict: 'review', reason });
const quarantine = (reason) => ({ verdict: 'quarantine', reason });
const known = (v) => v !== null && v !== undefined;

export function isProtected(name, policy = DEFAULT_POLICY) {
  return policy.whitelist.includes(name) || policy.protectedPrefixes.some((p) => name.startsWith(p));
}

/** Uncommitted work is never moved automatically, whatever the declared policy. */
function dirtyGuard(e) {
  if (!known(e.trackedChanges) || !known(e.untrackedPreserved)) return review('status-unknown');
  if (e.trackedChanges > 0 || e.untrackedPreserved > 0) return review('dirty');
  return null;
}

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s));

/**
 * A birth declaration is only valid when complete — exactly what scripts/worktree-new.mjs writes:
 * owner + policy + createdAt, plus expiresAt for ttl. A stray hand-written key is not a declaration.
 */
function isCompleteDeclaration(l) {
  if (typeof l.owner !== 'string' || l.owner.trim() === '' || !isIsoDate(l.createdAt)) return false;
  return l.policy !== 'ttl' || isIsoDate(l.expiresAt);
}

function classifyDeclared(e, policy, now) {
  if (!isCompleteDeclaration(e.lifecycle)) return review('declaration-incomplete');
  const { policy: declared, expiresAt } = e.lifecycle;
  if (declared === 'never') return keep('policy-never');
  if (declared === 'ttl') {
    if (now < Date.parse(expiresAt)) return keep('ttl-active');
    return dirtyGuard(e) ?? quarantine('ttl-expired');
  }
  if (declared === 'merged') {
    const dirty = dirtyGuard(e);
    if (dirty) return dirty;
    if (!known(e.inMain)) return review('ancestry-unknown');
    if (!e.inMain) return keep('not-merged-yet');
    if (!known(e.idleDays)) return review('idle-unknown');
    if (e.idleDays < policy.mergedIdleDays) return keep('recently-active');
    return quarantine('merged-idle');
  }
  return review('policy-invalid');
}

/**
 * @param {object} e facts for one directory (see collectEntries in worktree-reaper.mjs)
 * @returns {{verdict: 'keep'|'review'|'quarantine', reason: string}}
 */
export function classifyEntry(e, policy = DEFAULT_POLICY, now = Date.now()) {
  if (e.isMain) return keep('main-repo');
  if (isProtected(e.name, policy)) return keep('whitelisted');
  if (e.locked) return keep('locked');
  if (!known(e.busy)) return review('process-probe-unknown');
  if (e.busy) return keep('in-use');

  // Orphans have no declaration, so they are only ever reported — hollow ones included.
  if (e.kind === 'orphan') {
    if (!known(e.empty)) return review('orphan-unknown');
    return review(e.empty ? 'orphan-hollow' : 'orphan-nonempty');
  }
  if (e.lifecycle === null) return review('lifecycle-unknown');
  if (!e.lifecycle?.policy) return review('undeclared');
  return classifyDeclared(e, policy, now);
}

/**
 * Quarantined directories: purge only after the restore window, never while in use or locked, and never
 * once someone worked in it after the move — the quarantine decision covered the directory as it was then,
 * not files or commits added later (it was clean when quarantined, so any dirt now is new work).
 */
function changedSinceQuarantine(q) {
  if (!known(q.trackedChanges) || !known(q.untrackedPreserved)) return review('status-unknown');
  if (q.trackedChanges > 0 || q.untrackedPreserved > 0) return review('changed-in-quarantine');
  if (!known(q.lastActivityMs)) return review('activity-unknown');
  // git times have 1 s resolution: activity in the same second as the move counts as after it.
  if (q.lastActivityMs >= Math.floor(q.quarantinedAt / 1000) * 1000) return review('changed-in-quarantine');
  return null;
}

/**
 * The owner's CURRENT declaration still governs a quarantined directory: `never` keeps it; the declaration
 * must still be complete and valid by the same rule as before quarantine (else review); and one written
 * after the move means someone changed their mind, so a human decides — the old quarantine record never
 * overrides newer or damaged owner intent.
 */
function ownerIntentSinceQuarantine(q) {
  const l = q.lifecycle;
  if (l === null || l === undefined) return review('lifecycle-unknown');
  if (l.policy === 'never') return keep('policy-never');
  if (!LIFECYCLE_POLICIES.includes(l.policy) || !isCompleteDeclaration(l)) return review('declaration-incomplete');
  if (Date.parse(l.createdAt) > q.quarantinedAt) return review('redeclared-in-quarantine');
  return null;
}

export function classifyQuarantined(q, policy = DEFAULT_POLICY, now = Date.now()) {
  if (q.locked) return keep('locked');
  if (!known(q.busy)) return review('process-probe-unknown');
  if (q.busy) return keep('in-use');
  if (!known(q.quarantinedAt)) return review('quarantine-unrecorded');
  const intent = ownerIntentSinceQuarantine(q);
  if (intent) return intent;
  const changed = changedSinceQuarantine(q);
  if (changed) return changed;
  const ageDays = (now - q.quarantinedAt) / 86_400_000;
  return ageDays >= policy.quarantineDays ? { verdict: 'purge', reason: 'quarantine-expired' } : keep('in-quarantine');
}

/** Parse `git worktree list --porcelain`. */
export function parseWorktreePorcelain(text) {
  const records = [];
  let cur = null;
  for (const line of `${text}\n`.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null, locked: false, prunable: false };
    } else if (!cur) {
    } else if (line === '') {
      records.push(cur);
      cur = null;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = true;
    }
  }
  return records;
}
