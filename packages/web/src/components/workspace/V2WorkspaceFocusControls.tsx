'use client';

import { useShellCopy } from '@/components/shell/shell-copy';
import { workspaceChromeCopy } from '@/components/workbench/workspace-chrome.shell-copy';

/** Reserve the top edge so the parent-document exit never covers a narrow iframe's own controls. */
export function V2WorkspaceFocusControls({
  onExit,
  onFullWindow,
  fullWindow = false,
}: {
  onExit: () => void;
  onFullWindow?: () => void;
  fullWindow?: boolean;
}) {
  const t = useShellCopy(workspaceChromeCopy).focus;
  return (
    <div
      role="toolbar"
      aria-label={t.controls}
      className="pointer-events-none relative order-first z-30 h-6 !flex-none !w-full flex justify-center px-2"
    >
      <div
        data-testid="workspace-focus-controls"
        className="pointer-events-auto flex h-6 min-w-0 max-w-full items-center overflow-hidden rounded-b-md border border-t-0 border-[var(--shell-hairline)] bg-[var(--shell-frame)] text-xs text-[var(--shell-body)]"
      >
        <button
          type="button"
          onClick={fullWindow ? onFullWindow : onExit}
          data-testid="workspace-focus-exit"
          aria-label={fullWindow ? t.exitFullWindow : t.exitLabel}
          className="flex h-full min-w-0 items-center gap-1 px-2 hover:bg-[var(--shell-selected)] focus-visible:bg-[var(--shell-selected)]"
        >
          <span aria-hidden="true">⤡</span>
          <span className="truncate">{fullWindow ? t.exitFullWindow : t.exit}</span>
          <span aria-hidden="true" className="shrink-0 text-[var(--shell-muted)]">
            · Esc
          </span>
        </button>
        {onFullWindow && !fullWindow && (
          <>
            <span aria-hidden="true" className="h-3 border-l border-[var(--shell-hairline)]" />
            <button
              type="button"
              onClick={onFullWindow}
              data-testid="workspace-focus-full-window"
              className="h-full shrink-0 whitespace-nowrap px-2 hover:bg-[var(--shell-selected)] focus-visible:bg-[var(--shell-selected)]"
            >
              {t.fullWindow}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
