import type { ContentReviewView } from './content-review-contract';

export function WorkspaceContentReviewSourceState({
  view,
  busy,
  refreshSource,
}: {
  readonly view: ContentReviewView;
  readonly busy: boolean;
  readonly refreshSource: () => Promise<void>;
}) {
  if (view.sourceState === 'unavailable')
    return (
      <p data-content-opening-state="blocked" className="p-3 text-sm text-cafe-muted">
        原内容当前不可读取；协作历史保留，但不展示旧内容缓存。
      </p>
    );
  if (view.sourceState !== 'changed') return null;
  return (
    <div
      data-content-opening-state="blocked"
      className="rounded border border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] p-3 text-sm text-cafe-muted"
    >
      <p>原文件已改动。已有批注会如实显示重定位或失联状态；确认后才切换到当前版本。</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void refreshSource()}
        className="mt-2 text-xs font-semibold text-cafe-accent hover:underline"
      >
        切换到当前版本
      </button>
    </div>
  );
}
