/**
 * A2A dispatch scheduling mode — the structured carrier of "serial vs parallel".
 *
 * WHY THIS EXISTS (F086/F216 sub-item, #1291 field incident):
 * A cat wrote two line-start @mentions in one reply and stated "并行，不串行" in prose.
 * The runtime pushed both onto ONE sequential worklist (route-serial.ts) and only ever
 * created the first target's invocation — but the projection layer emitted two identical
 * `a2a_handoff` pills at the same millisecond, so the UI drew two equivalent arrows.
 * The scheduling mode was carried by nothing at all; readers inferred it from the fact
 * that two targets appeared side by side. That is a silent semantic downgrade.
 *
 * CONTRACT:
 * - Mode is ALWAYS explicit and structured. It is never inferred from how many targets
 *   there are, from their ordering, or from natural language in the message body.
 * - `serial`   — one ordered worklist; target N+1 starts only after target N terminates.
 *                Inline line-start @mentions are serial BY CONTRACT (see A2A_INLINE_MENTION_MODE).
 * - `parallel` — independent fan-out; every target obtains its own invocation/Queue custody
 *                before any target reaches a terminal. Only reachable through the structured
 *                `cat_cafe_multi_mention` + `action.mode="parallel"` + `parallelIntent` path.
 */
export type A2ARoutingMode = 'serial' | 'parallel';

/**
 * Inline line-start @mentions are SERIAL, always.
 *
 * This is a normalization, not a guess: it names the semantics route-serial.ts has always
 * executed (a single `worklist` drained by a single `while`). Declaring it explicitly is what
 * stops multi-@ from silently *looking* parallel. Cats that want real fan-out must ask for it
 * structurally via `cat_cafe_multi_mention(mode="parallel", parallelIntent=...)`; the runtime
 * never reads the prose for words like "并行".
 */
export const A2A_INLINE_MENTION_MODE: A2ARoutingMode = 'serial';

/**
 * Structured routing projection attached to one dispatched target.
 *
 * `index`/`total` are 1-based positions inside the dispatch's real scheduling unit — NOT merely the
 * targets named in one turn (砚砚 R1):
 *  - `serial`   — the position inside the whole pending worklist, so `total` also counts original
 *                 targets still queued ahead. That is the honest start order: those cats really do
 *                 run before this leg. Only `index === 1` is actually starting now.
 *  - `parallel` — bookkeeping over the siblings that ACTUALLY obtained custody (rejected/depth-limited
 *                 targets are never projected), implying no ordering between them.
 */
export interface A2ARoutingProjection {
  readonly mode: A2ARoutingMode;
  readonly index: number;
  readonly total: number;
}

/** True when this target is the one actually starting now (serial 第 1 棒, or any parallel target). */
export function isRoutingProjectionStartingNow(projection: A2ARoutingProjection): boolean {
  return projection.mode === 'parallel' || projection.index <= 1;
}
