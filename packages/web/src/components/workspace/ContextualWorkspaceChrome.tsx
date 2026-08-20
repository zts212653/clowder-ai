'use client';

import type { ReactNode } from 'react';

export type WorkspaceHostMode = 'workspace' | 'status' | 'transcript';

interface ContextualWorkspaceChromeProps {
  mode: WorkspaceHostMode;
  onFold: () => void;
  onNavigateHome?: () => void;
  children: ReactNode;
}

const HOST_LABELS: Record<WorkspaceHostMode, { label: string; dot: string }> = {
  workspace: { label: 'Workspace', dot: 'bg-cafe-accent' },
  status: { label: '状态与会话', dot: 'bg-[var(--semantic-info)]' },
  transcript: { label: '会议伴随', dot: 'bg-[var(--semantic-success)]' },
};

export function ContextualWorkspaceChrome({ mode, onFold, onNavigateHome, children }: ContextualWorkspaceChromeProps) {
  const host = HOST_LABELS[mode];

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--console-panel-bg)]"
      data-testid="contextual-workspace-shell"
    >
      <header
        className="flex h-11 shrink-0 items-center border-b border-cafe-subtle/70 bg-cafe-surface/60 px-3.5"
        data-workspace-chrome-layer="shell"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {onNavigateHome && (
            <button
              type="button"
              onClick={onNavigateHome}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken hover:text-cafe-black"
              title="返回 Workspace"
              aria-label="返回 Workspace"
              data-testid="workspace-shell-home"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m9.5 3-5 5 5 5" />
              </svg>
            </button>
          )}
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${host.dot}`} aria-hidden="true" />
          <span className="truncate text-xs font-semibold text-cafe-black">{host.label}</span>
        </div>

        {mode !== 'workspace' && (
          <button
            type="button"
            onClick={onFold}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken hover:text-cafe-black"
            title="收起侧栏"
            aria-label="收起侧栏"
            data-testid="workspace-shell-fold"
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5Z" />
              <path d="M10.5 2.5v11M7.5 6 5.5 8l2 2" />
            </svg>
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  );
}
