import type { GitHubWaitLifecycleResult } from './GitHubWaitLifecycleService.js';

/**
 * What a delivered wait outcome permits, carried to whoever happens to deliver it.
 *
 * sol R33: the pending outcome is SHARED. Review can create it, and the next poll to re-publish
 * it may be CI or conflict — adapters that never saw the decision that produced it. When the
 * R4 pause lived only in the Review path, a first-delivery failure plus a CI poll was enough to
 * cancel it: the message said "Automatic re-request paused once" and the owner was woken anyway.
 * A safety decision must not depend on which adapter happened to pick the outcome up.
 *
 * So it is projected here, once, from the lifecycle result — and it is REQUIRED on every router
 * result that can carry a delivery, which makes dropping it a type error rather than the silent
 * omission it was. This is the fifth time in this PR that a rule fixed in one consumer was
 * missing from its siblings; the projection exists so there is no per-adapter copy to forget.
 */
export interface WaitWakeDisposition {
  /** The outcome itself says: deliver, but do not auto-wake the owner. */
  readonly autoWakeSuppressed: boolean;
  /**
   * Were THIS call's events evaluated? False means an earlier outcome was re-published, so the
   * current poll's own facts (CI bucket, conflict state) describe a different observation and
   * must not reshape this outcome's wake.
   */
  readonly observationEvaluated: boolean;
}

export function projectWaitWakeDisposition(result: GitHubWaitLifecycleResult): WaitWakeDisposition {
  if (result.kind !== 'notified') {
    return { autoWakeSuppressed: false, observationEvaluated: result.observationEvaluated };
  }
  return {
    autoWakeSuppressed: result.outcome.autoWakeSuppressed === true,
    observationEvaluated: result.observationEvaluated,
  };
}

/**
 * The one question every consumer asks before Queue-admitting an owner.
 *
 * The parameter is REQUIRED, not `Partial`. sol R34: an optional shape let a future consumer
 * typecheck while dropping the field and fall back to waking — the exact silent omission this
 * projection exists to make impossible. Required means a new delivering shape cannot compile
 * until it answers the question.
 *
 * The two fields default OPPOSITE ways, and each direction is chosen by which loss is
 * irreversible rather than by symmetry. A cursor advanced without evidence destroys feedback
 * permanently, so `observationEvaluated` is never assumed. A wake withheld without evidence
 * destroys the owner's only notification — the silent-mute class A26 ranks above any amount of
 * noise, since an extra wake is merely noise and recoverable. Reading `!== true` rather than
 * `=== false` keeps that permissive direction for an untyped JS test stub, which the type system
 * no longer has any way to reach from production code.
 */
export function mayAutoWakeOwner(disposition: WaitWakeDisposition): boolean {
  return disposition.autoWakeSuppressed !== true;
}
