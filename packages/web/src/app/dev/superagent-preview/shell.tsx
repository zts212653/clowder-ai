'use client';

import { WorldRailFrame } from '@cat-cafe/ui';
import { type ReactNode, useLayoutEffect } from 'react';
import { CatBallImage, ShellGlyph } from '@/components/shell/ShellIcons';
import { ShellPresentationContext } from '@/components/shell/shell-presentation';
import { ThreadSidebarV2Header } from '@/components/ThreadSidebar/ThreadSidebarV2Header';
import { SuperagentPreviewEntry } from './entry';
import { sampleThreads } from './fixtures';

const readOnlyNavigation = () => {};

/** Native visual components, with no live Host providers or background connections. */
export function SuperagentPreviewShell({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.shell = 'v2';
    return () => {
      delete document.documentElement.dataset.shell;
    };
  }, []);
  return (
    <ShellPresentationContext.Provider value="v2">
      <div className="console-shell flex h-dvh overflow-hidden">
        <WorldRailFrame aria-label="主导航样例">
          <CatBallImage />
          <span className="mt-6">
            <ShellGlyph name="newchat" />
          </span>
        </WorldRailFrame>
        <aside
          data-shell-sidebar="v2"
          className="hidden h-full w-60 shrink-0 flex-col md:flex"
          style={{ background: 'var(--shell-frame)', borderRight: '1px solid var(--shell-hairline)' }}
        >
          <fieldset disabled className="pointer-events-none" aria-label="原生导航外观，体验稿中只读">
            <ThreadSidebarV2Header
              creationPhase="idle"
              onNewThread={readOnlyNavigation}
              searchQuery=""
              onSearchQueryChange={readOnlyNavigation}
              uncategorizedCount={0}
              onOrganizeWithCat={readOnlyNavigation}
              onOpenOrganizer={readOnlyNavigation}
              onOpenBootcamp={readOnlyNavigation}
              unreadCount={0}
              isMarkingAllRead={false}
              onMarkAllRead={readOnlyNavigation}
            />
          </fieldset>
          <SuperagentPreviewEntry />
          <div className="px-3 py-2 text-xs text-[var(--shell-muted)]">最近 · 会话样例</div>
          {sampleThreads.map((thread) => (
            <div key={thread.id} className="px-4 py-3 text-sm">
              {thread.title}
            </div>
          ))}
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </ShellPresentationContext.Provider>
  );
}
