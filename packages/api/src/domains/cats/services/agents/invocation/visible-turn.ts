/**
 * F194 Phase Z9 (砚砚 R1 P1-2) — canonical bubble identity stamp helper.
 *
 * Live broadcast & persistence write paths must produce a consistent
 * `(invocationId, turnInvocationId)` pair so frontend bubble identity
 * (per-visible-cat-turn) never falls back to parent (which collapses
 * multi-turn same-cat under shared parent into one bubble — R13 + R14).
 *
 * Contract:
 *   - `invocationId` = parent / chain (liveness, queue, cancel SoT)
 *   - `turnInvocationId` = per-visible-cat-turn id (bubble identity SoT)
 *
 * AC-Z25 backend always-stamp guarantees this: every assistant raw record
 * write site stamps both fields explicitly. AC-Z25 R1 P1-1 fix in
 * route-serial.ts + route-parallel.ts ensures yielded events carry
 * `msg.invocationId = ownInvocationId` so this helper receives a defined
 * turn id from upstream (not undefined, which would fall back to parent).
 *
 * Defense in depth: even if upstream forgot to stamp, helper falls back
 * to parent for the turn field. This preserves Z8 backward compatibility
 * but should never fire in practice on post-Z9 code paths.
 */

export interface VisibleTurnStamp {
  invocationId: string;
  turnInvocationId: string;
}

export function stampVisibleTurn(parentInvocationId: string, msgInvocationId: string | undefined): VisibleTurnStamp {
  return {
    invocationId: parentInvocationId,
    turnInvocationId: msgInvocationId ?? parentInvocationId,
  };
}
