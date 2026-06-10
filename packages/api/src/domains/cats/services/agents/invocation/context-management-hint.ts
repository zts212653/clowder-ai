/**
 * F225 软层: build, render, and DELIVER the cat-facing context-management hint.
 *
 * Delivery design (cloud review P1, 2026-06-09): a `system_info` output never
 * reaches the cat's cognition — routing only feeds `text` into the cat-visible
 * `previousResponses`, and `ContextAssembler` excludes `userId='system'` messages
 * from the prompt. So the warn hint rides the **prompt-injection channel** instead,
 * mirroring the `_needsReinjection` pattern: queued on the warn turn, taken back as
 * a prompt prefix and prepended to `effectivePrompt` on the cat's next invocation
 * (prepend-to-prompt-string is universal across all CLIs — see invoke-single-cat).
 */
import type { ContextHealth, ContextManagementHint } from '@cat-cafe/shared';

/**
 * Build the cat-facing hint from raw health source + compression count. Called
 * from invoke-single-cat ONLY when shouldTakeAction returns `{ type: 'warn' }`.
 *
 * `fillConfidence` maps the current token-based health `source`; `bytes_health` /
 * `unavailable` are produced by future per-runtime health paths (see the
 * ContextManagementHint type docs). `compressionCount` is the objective drift
 * anchor the cat checks in axis 3 of the `context-self-management` self-check.
 */
export function buildContextManagementHint(args: {
  source: ContextHealth['source'];
  compressionCount: number;
}): ContextManagementHint {
  return {
    severity: 'warn',
    fillConfidence: args.source === 'exact' ? 'exact_token' : 'approx_token',
    compressionCount: args.compressionCount,
  };
}

/**
 * Render the hint as the text block the cat actually reads in its prompt. Must
 * carry the literal token `context_management_hint` so the L0 §8 reflex fires,
 * plus the data fields and a pointer to the `context-self-management` skill.
 * Gives data + a thin pointer (the judgment lives in the skill — KD-8).
 */
export function formatContextManagementHint(hint: ContextManagementHint): string {
  return [
    `[context_management_hint] severity=${hint.severity} · fillConfidence=${hint.fillConfidence} · compressionCount=${hint.compressionCount}`,
    '你进入了 context warn 区。加载 context-self-management skill 做三轴自检（线/树? 干净断点? 压了几轮?）再决定 handoff/续/冲刺——别反射 handoff、也别无脑等压缩。',
  ].join('\n');
}

/**
 * Pending hints keyed by `${userId}:${catId}:${threadId}` (same key the
 * `_needsReinjection` reinjection uses). In-memory + ephemeral by design: a hint
 * is a nudge, not durable state — if a process restart drops it, the next warn
 * turn re-queues it. Mirrors the `_needsReinjection` Set lifecycle.
 */
const pendingContextHints = new Map<string, string>();

/** Queue a hint for `key` to be injected into that (cat,thread)'s next prompt. */
export function queueContextHint(key: string, hint: ContextManagementHint): void {
  pendingContextHints.set(key, formatContextManagementHint(hint));
}

/**
 * Take (and clear) the pending prompt prefix for `key`, or null if none.
 * Consumed-once so the hint injects exactly once per warn turn — no infinite
 * re-injection while the cat keeps working.
 */
export function takeContextHintPrefix(key: string): string | null {
  const text = pendingContextHints.get(key);
  if (text == null) return null;
  pendingContextHints.delete(key);
  return text;
}

/** Test-only: clear all pending hints (mirrors the _needsReinjection reset). */
export function __resetContextHints(): void {
  pendingContextHints.clear();
}
