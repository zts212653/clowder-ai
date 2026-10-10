/**
 * A single mode marker for independent sampling. Per-member execution,
 * cancellation, and usage already have canonical homes in message bubbles and
 * the composer, so this header must not duplicate them.
 */
export function IdeateHeader() {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-cafe bg-cafe-surface px-5 py-2">
      <span className="text-sm font-medium text-cafe-secondary">独立观点采样</span>
      <span className="text-xs text-cafe-muted">本轮各成员独立思考并分别回答，彼此不会互相触发</span>
    </div>
  );
}
