'use client';
import { useWatcher } from '@/hooks/useWatcher';
import { SuggestionAvatar } from '../suggestions/SuggestionRow';

function pauseTime(until: number) {
  return new Date(until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function WatcherChip({ threadId }: { threadId: string }) {
  const { state, error } = useWatcher(threadId);
  if (!state || error || !state.rolloutEnabled || !state.enabled || !state.capability.supported) return null;
  const suffix = state.pausedUntil
    ? `已暂停至 ${pauseTime(state.pausedUntil)}`
    : state.labelMuted
      ? '免打扰'
      : state.reviewing
        ? '查看中'
        : '';
  return (
    <span className="w-chip" role="status" data-testid="watcher-chip">
      <SuggestionAvatar catId={state.config.memberCatId} watcher />
      守望猫 · {state.memberName}
      {suffix && (
        <span className="inline-flex items-center gap-1.5 pl-0.5 text-cafe-secondary">
          {state.reviewing && !state.pausedUntil && !state.labelMuted && (
            <span className="w-dot is-reviewing" aria-hidden="true" />
          )}
          {suffix}
        </span>
      )}
    </span>
  );
}
export function WatcherThreadCard({ threadId }: { threadId: string }) {
  const { state, error, saving, update } = useWatcher(threadId);
  const selected =
    state && (state.config.scope === 'all' ? state.control.enabled !== false : state.control.enabled === true);
  return (
    <div
      className="watcher-thread-card mb-2 rounded-xl border border-cafe-subtle px-3 py-2"
      data-testid="watcher-thread-card"
    >
      <button
        type="button"
        role="switch"
        aria-checked={selected ?? false}
        aria-label="守望这条对话"
        disabled={!state || saving}
        onClick={() => void update({ enabled: !selected })}
        className="flex w-full items-center justify-between rounded text-left text-sm text-cafe-primary disabled:opacity-50"
      >
        <span>守望这条对话</span>
        <span aria-hidden="true" className={`watcher-switch ${selected ? 'is-on' : ''}`} />
      </button>
      <a href="/settings?s=concierge#watcher" className="mt-1 block text-xs text-cafe-secondary">
        {state?.memberName ?? '加载中'} ›
      </a>
      {state?.pausedUntil && (
        <button
          type="button"
          disabled={saving}
          className="mt-2 text-xs text-cafe-muted"
          onClick={() => void update({ pausedUntil: null })}
        >
          已暂停至 {pauseTime(state.pausedUntil)} · 恢复
        </button>
      )}
      {state && !state.config.enabled && <p className="mt-1 text-xs text-cafe-muted">总开关已关闭</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
