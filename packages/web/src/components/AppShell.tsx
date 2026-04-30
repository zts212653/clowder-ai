'use client';

import { usePathname } from 'next/navigation';
import { Suspense } from 'react';
import { ActivityBar } from './ActivityBar';
import { ThreadSidebar } from './ThreadSidebar';
import { detectRoutePrefix } from './ThreadSidebar/thread-navigation';

const CHROMELESS_ROUTES = ['/story-export', '/pixel-brawl', '/showcase'];

interface AppShellProps {
  children: React.ReactNode;
}

const SIDEBAR_HIDDEN_ROUTES = ['/settings', '/signals', '/memory', '/mission'];

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const isExport =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('export') === 'true';
  if (isExport || CHROMELESS_ROUTES.some((r) => pathname.startsWith(r))) {
    return <>{children}</>;
  }
  const hideThreadSidebar = SIDEBAR_HIDDEN_ROUTES.some((r) => pathname.startsWith(r));
  return (
    <div className="console-shell flex h-screen h-dvh overflow-hidden">
      <Suspense fallback={<div className="w-12 flex-shrink-0" aria-hidden="true" />}>
        <ActivityBar />
      </Suspense>
      {!hideThreadSidebar && (
        <Suspense fallback={<div className="hidden md:block w-[260px] flex-shrink-0" aria-hidden="true" />}>
          <div className="hidden md:block w-[260px] flex-shrink-0">
            <ThreadSidebar className="w-full h-full" routePrefix={detectRoutePrefix()} />
          </div>
        </Suspense>
      )}
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
