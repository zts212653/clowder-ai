import type { ReactNode } from 'react';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';

export function ContentLandingHeader({
  title,
  navigationOrigin,
  onBack,
  onOpenFileTools,
  versionControl,
}: {
  readonly title: string;
  readonly navigationOrigin?: WorkspaceFileNavigationOrigin;
  readonly onBack?: () => void;
  readonly onOpenFileTools?: () => void;
  readonly versionControl?: ReactNode;
}) {
  return (
    // In a narrow column (side-by-side panes, 390px) the controls wrap onto a second line so the
    // title keeps at least ~8rem instead of shrinking to a single character.
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-cafe-subtle px-3 py-2">
      <h2 className="min-w-[8rem] flex-1 truncate text-sm font-semibold" title={title}>
        {title}
      </h2>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
        {versionControl}
        {onOpenFileTools ? (
          <button
            type="button"
            onClick={onOpenFileTools}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-cafe-muted hover:text-cafe"
          >
            文件工具
          </button>
        ) : null}
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-cafe-muted hover:text-cafe"
          >
            {navigationOrigin ? '返回来源' : '返回'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
