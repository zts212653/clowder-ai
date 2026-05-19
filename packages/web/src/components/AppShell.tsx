'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useLayoutEffect } from 'react';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { initSidebarWidth, useSidebarStore } from '@/stores/sidebarStore';
import { ActivityBar } from './ActivityBar';
import { ThreadSidebar } from './ThreadSidebar';
import { ResizeHandle } from './workspace/ResizeHandle';

const CHROMELESS_ROUTES = ['/story-export', '/pixel-brawl', '/showcase'];

const SIDEBAR_HIDDEN_ROUTES = ['/settings', '/marketplace', '/signals', '/memory', '/mission'];

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <Suspense fallback={children}>
      <AppShellContent>{children}</AppShellContent>
    </Suspense>
  );
}

function AppShellContent({ children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const isExport = searchParams.get('export') === 'true';
  const { isOpen, width, close, handleResize, resetWidth } = useSidebarStore();
  const isDesktop = useIsDesktop();

  useLayoutEffect(() => {
    initSidebarWidth();
  }, []);

  if (isExport || CHROMELESS_ROUTES.some((r) => pathname.startsWith(r))) {
    return <>{children}</>;
  }

  const showSidebar = isOpen && isDesktop && !SIDEBAR_HIDDEN_ROUTES.some((r) => pathname.startsWith(r));

  return (
    <div className="console-shell flex h-screen h-dvh overflow-hidden">
      <Suspense fallback={<div className="w-12 flex-shrink-0" aria-hidden="true" />}>
        <ActivityBar />
      </Suspense>
      {showSidebar && (
        <div className="flex items-stretch flex-shrink-0">
          <div style={{ width }} className="flex-shrink-0">
            <ThreadSidebar onClose={close} className="w-full" />
          </div>
          <ResizeHandle
            direction="horizontal"
            label="左侧对话栏"
            onResize={handleResize}
            onCollapse={close}
            onDoubleClick={resetWidth}
          />
        </div>
      )}
      <div className="flex-1 min-w-0 overflow-y-auto">{children}</div>
    </div>
  );
}
