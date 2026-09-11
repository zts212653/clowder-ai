// Ordered shutdown for the desktop runtime.
//
// stopAll() used to kill every child concurrently, which loses two guarantees:
//
//   * the Web process keeps routing new requests into an API that is already
//     being torn down;
//   * the API can be killed mid-write at the same instant Redis dies, so an
//     in-flight call can be lost and Redis may not finish persisting.
//
// Shutting down in dependency order fixes both: stop accepting new work, let
// the API finish and flush, and only then stop the datastore it writes to.
//
// Pure logic so the order and the grace policy are unit-tested without
// spawning anything.

/**
 * Shutdown stages, most-dependent first.
 * `graceMs` is how long a stage may take to exit before it is forced.
 *
 * The graces sum to TOTAL_SHUTDOWN_BUDGET_MS on purpose: the Windows installer
 * gives the app a bounded window to quit cooperatively before it force-cleans
 * (desktop/installer/cat-cafe.iss PrepareToInstall), so teardown must fit
 * inside that window even when a stage has to be forced.
 */
const SHUTDOWN_STAGES = [
  {
    name: 'web',
    graceMs: 2000,
    reason: 'stop routing new requests before anything behind it goes away',
  },
  {
    name: 'api',
    graceMs: 5000,
    reason: 'let in-flight calls finish and flush to Redis',
  },
  {
    name: 'redis',
    graceMs: 3000,
    reason: 'persist last, after the API has stopped writing',
  },
];

/** Grace period for a process this module does not know about. */
const UNKNOWN_STAGE_GRACE_MS = 5000;

/**
 * Total wall-clock budget for the whole teardown. Kept below the installer's
 * 15s coordinated-quit window so a forced stage cannot overrun it.
 */
const TOTAL_SHUTDOWN_BUDGET_MS = 10_000;

/** Budget left for the remaining stages. Never negative. */
function remainingBudget(startedAt, now = Date.now(), budgetMs = TOTAL_SHUTDOWN_BUDGET_MS) {
  return Math.max(0, budgetMs - (now - startedAt));
}

/** How long a stage may take, never exceeding what is left of the budget. */
function stageTimeoutMs(target, remainingMs) {
  return Math.max(0, Math.min(target.graceMs, remainingMs));
}

/**
 * Order the running processes for shutdown.
 *
 * @param {string[]} procNames names currently tracked by the service manager
 * @returns {Array<{name: string, graceMs: number, reason: string, known: boolean}>}
 *   Known services in dependency order, then any unknown names in input order.
 */
function orderShutdownTargets(procNames = []) {
  const names = [...new Set(procNames)];
  const knownNames = new Set(SHUTDOWN_STAGES.map((stage) => stage.name));

  const targets = SHUTDOWN_STAGES.filter((stage) => names.includes(stage.name)).map((stage) => ({
    ...stage,
    known: true,
  }));

  for (const name of names) {
    if (knownNames.has(name)) continue;
    targets.push({
      name,
      graceMs: UNKNOWN_STAGE_GRACE_MS,
      reason: 'unknown service',
      known: false,
    });
  }

  return targets;
}

/** One-line description for the desktop log. */
function formatShutdownPlan(targets = []) {
  if (targets.length === 0) return 'nothing to stop';
  return targets.map((target) => `${target.name}(${target.graceMs}ms)`).join(' → ');
}

module.exports = {
  SHUTDOWN_STAGES,
  TOTAL_SHUTDOWN_BUDGET_MS,
  UNKNOWN_STAGE_GRACE_MS,
  formatShutdownPlan,
  orderShutdownTargets,
  remainingBudget,
  stageTimeoutMs,
};
