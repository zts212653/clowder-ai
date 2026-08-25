'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useWorkspaceNavigate } from '@/hooks/useWorkspaceNavigate';
import { destroyPlaybackRuntime, getPlaybackManager } from '@/services/playbackRuntime';
import { CallbackAuthSnapshotMount } from '@/stores/callbackAuthStore';
import { useChatStore } from '@/stores/chatStore';
import { initSidebarWidth, useSidebarStore } from '@/stores/sidebarStore';
import { ActivityBar } from './ActivityBar';
import { ConciergeHost } from './concierge/ConciergeHost';
import { DesktopUpdatePrompt } from './DesktopUpdatePrompt';
import { ListenModePlayer } from './listen-mode/ListenModePlayer';
import { TheaterReplayHost } from './story-player/TheaterReplayHost';
import { ThreadSidebar } from './ThreadSidebar';
import {
  getBrowserThreadRoutePathname,
  getThreadIdFromPathname,
  subscribeBrowserThreadRoute,
} from './ThreadSidebar/thread-navigation';
import { FloatingPresentationSurfaceHost } from './workspace/FloatingPresentationSurfaceHost';
import { ResizeHandle } from './workspace/ResizeHandle';

const CHROMELESS_ROUTES = ['/story', '/story-export', '/pixel-brawl', '/showcase'];

const SIDEBAR_HIDDEN_ROUTES = ['/settings', '/marketplace', '/signals', '/memory', '/mission', '/starry'];

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  useEffect(() => {
    getPlaybackManager();
    return destroyPlaybackRuntime;
  }, []);

  return (
    <>
      <Suspense fallback={children}>
        <AppShellContent>{children}</AppShellContent>
      </Suspense>
      <DesktopUpdatePrompt />
    </>
  );
}

function AppShellContent({ children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const livePathname = useSyncExternalStore(subscribeBrowserThreadRoute, getBrowserThreadRoutePathname, () => pathname);
  const searchParams = useSearchParams();
  const isExport = searchParams.get('export') === 'true';
  const { isOpen, width, close, handleResize, resetWidth } = useSidebarStore();
  const isDesktop = useIsDesktop();
  const rightPanelMode = useChatStore((state) => state.rightPanelMode);
  const workspaceMode = useChatStore((state) => state.workspaceMode);
  const routeThreadId = getThreadIdFromPathname(livePathname);
  const isChatRoute = livePathname === '/' || livePathname.startsWith('/thread/');
  const isChromeless = CHROMELESS_ROUTES.some((route) => pathname.startsWith(route));
  useWorkspaceNavigate(isChatRoute ? routeThreadId : null, {
    isChatRoute,
    isWorkspaceVisible: isDesktop,
    enabled: !isExport,
  });

  useLayoutEffect(() => {
    initSidebarWidth();
  }, []);

  if (isExport || isChromeless) {
    return <>{children}</>;
  }

  const showSidebar = isOpen && isDesktop && !SIDEBAR_HIDDEN_ROUTES.some((r) => pathname.startsWith(r));
  const workspaceVisible = isChatRoute && rightPanelMode === 'workspace' && (isDesktop || workspaceMode !== 'approval');

  return (
    <div className="console-shell flex h-screen h-dvh overflow-hidden">
      <Suspense fallback={<div className="w-12 flex-shrink-0" aria-hidden="true" />}>
        <ActivityBar />
      </Suspense>
      {/* Callback-auth snapshot provider: mounted at AppShell level (not chat
          layout) so the zustand store is populated on ALL routes — settings,
          memory, mission, etc. The observability panel and per-cat status dots
          read from this store; keeping it chat-only meant the panel showed "..."
          when navigating to settings without visiting chat first. Returns null;
          30s poll re-render is confined to this leaf. */}
      <CallbackAuthSnapshotMount />
      {/* F252/F299: replay host is independent of the conditionally mounted sidebar. */}
      <TheaterReplayHost />
      {showSidebar && (
        <div className="flex items-stretch flex-shrink-0">
          <div style={{ width }} className="flex-shrink-0">
            <ThreadSidebar onClose={close} className="w-full" routeThreadId={routeThreadId} />
          </div>
          <ResizeHandle
            direction="horizontal"
            label="左侧对话栏"
            onResize={handleResize}
            onCollapse={close}
            onDoubleClick={resetWidth}
            showLine={false}
          />
        </div>
      )}
      <div className="flex-1 min-w-0 overflow-y-auto">{children}</div>
      <ListenModePlayer variant="mini" workspaceVisible={workspaceVisible} />
      {/* F226: presentation surface floating window — mounted at AppShell root (outside route
          children) so the float survives both workspace mode-tab switches AND full-page route
          changes (/memory, /settings, /mission-hub). KD-1. */}
      <FloatingPresentationSurfaceHost />
      {/* F229: concierge ball + panel — root-level mount for INV-6 route survival.
          z-30 (ball) < z-[35] (presentation surface). */}
      <ConciergeHost />
      {/* F246 Phase C: Approval Hub moved to workspace panel tab — drawer removed */}
    </div>
  );
}
