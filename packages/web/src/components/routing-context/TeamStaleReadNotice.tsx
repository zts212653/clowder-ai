/**
 * F293 — a failed refresh keeps the last successful snapshot on screen, because losing
 * the roster helps nobody. What it must not do is let that snapshot keep passing for
 * current state: the routing facts underneath may have moved since.
 */
export function TeamStaleReadNotice({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div
      className="mb-4 rounded-xl border border-conn-amber-ring bg-conn-amber-bg p-3 text-xs text-conn-amber-text"
      data-testid="team-stale-read"
      role="status"
    >
      <p>
        最新一次读取失败，下面是上次成功读到的内容，可能已经不是现在的状态。
        <span className="ml-1 opacity-80">（{error}）</span>
      </p>
      <button type="button" onClick={onRetry} className="mt-2 font-semibold underline" data-testid="team-stale-retry">
        重新读取
      </button>
    </div>
  );
}
