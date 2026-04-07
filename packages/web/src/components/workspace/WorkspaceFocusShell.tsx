'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';

interface WorkspaceFocusShellProps {
  children?: ReactNode;
  onExit: () => void;
}

/**
 * Shared shell for "focus mode" panes — fills the workspace panel,
 * hides surrounding chrome, and provides a consistent exit affordance.
 *
 * UX fix (intake #362): added fade transition + prominent exit button
 * (Escape only works when focus is in parent document, not inside iframes).
 */
export function WorkspaceFocusShell({ children, onExit }: WorkspaceFocusShellProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onExit]);

  return (
    <div
      data-testid="workspace-focus-shell"
      className="relative h-full min-h-0 min-w-0 flex flex-col overflow-auto animate-fade-in"
    >
      <button
        type="button"
        onClick={onExit}
        className="absolute top-3 right-3 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-cocreator-light/80 text-cocreator-dark/80 border border-cocreator-dark/10 backdrop-blur-sm shadow-sm hover:bg-cocreator-light transition-colors"
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M1 1l8 8M9 1l-8 8" />
        </svg>
        退出专注
      </button>
      <div data-testid="workspace-focus-shell-viewport" className="flex-1 min-h-0 min-w-0 overflow-auto">
        {children}
      </div>
    </div>
  );
}
