'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ActivityBar } from './ActivityBar';

const CHROMELESS_ROUTES = ['/story-export', '/pixel-brawl', '/showcase'];

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <Suspense fallback={<>{children}</>}>
      <AppShellContent>{children}</AppShellContent>
    </Suspense>
  );
}

function AppShellContent({ children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const isExport = searchParams.get('export') === 'true';

  if (isExport || CHROMELESS_ROUTES.some((r) => pathname.startsWith(r))) {
    return <>{children}</>;
  }
  return (
    <div className="console-shell flex h-screen h-dvh overflow-hidden">
      <Suspense fallback={<div className="w-12 flex-shrink-0" aria-hidden="true" />}>
        <ActivityBar />
      </Suspense>
      <div className="flex-1 min-w-0 overflow-y-auto">{children}</div>
    </div>
  );
}
