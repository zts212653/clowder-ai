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
import { isMemoryRoute } from './shell/shell-navigation';
import {
  parseShellPresentation,
  readShellPresentation,
  type ShellPresentation,
  useShellPresentation,
  writeShellPresentation,
} from './shell/shell-presentation';
import { WorldRail } from './shell/WorldRail';
import { TheaterReplayHost } from './story-player/TheaterReplayHost';
import { ThreadSidebar } from './ThreadSidebar';
import {
  getBrowserThreadRoutePathname,
  getThreadIdFromPathname,
  subscribeBrowserThreadRoute,
} from './ThreadSidebar/thread-navigation';
import { ThreadChatRuntimeProvider } from './thread-chat';
import { FloatingPresentationSurfaceHost } from './workspace/FloatingPresentationSurfaceHost';
import { ResizeHandle } from './workspace/ResizeHandle';

const CHROMELESS_ROUTES = ['/story', '/story-export', '/pixel-brawl', '/showcase', '/dev/f277-attention-preview'];

const SIDEBAR_HIDDEN_ROUTES = [
  '/settings',
  '/marketplace',
  '/signals',
  '/memory',
  '/mission',
  '/starry',
  '/collective',
];

interface AppShellProps {
  children: React.ReactNode;
}

// Viewport updates must not replace this boundary's children before it has hydrated.
const activityRail = (
  <Suspense fallback={<div className="w-12 flex-shrink-0" aria-hidden="true" />}>
    <ActivityBar />
  </Suspense>
);

// F322 Stage 1: the decided Café 1.6 rail, chosen by the one presentation switch (classic stays as above).
const worldRail = (
  <Suspense fallback={<div className="w-[52px] flex-shrink-0" aria-hidden="true" />}>
    <WorldRail />
  </Suspense>
);

/**
 * `?shell=v2|classic` is a one-time INTENT attached to a navigation, not a standing instruction. It is applied when the
 * URL is entered — first load, or a client navigation to another route (or to another shell value) — and never again while
 * the user stays on that URL: their own choice (设置与管理 › 主题 › 界面版本) wins even though the query is still in the address bar.
 * A navigation that arrives with the same value on a different route is a fresh intent; re-rendering the current URL is not.
 * Storage stays the truth; the location is only read, not remembered.
 */
function useShellPresentationFromUrl(pathname: string, shellParam: string | null): ShellPresentation {
  const presentation = useShellPresentation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pathname IS a new navigation, which is what re-arms the intent
  useEffect(() => {
    const requested = parseShellPresentation(shellParam);
    if (requested && requested !== readShellPresentation()) writeShellPresentation(requested);
  }, [pathname, shellParam]);
  // Tokens are scoped to [data-shell="v2"] on <html> so portalled tips/menus get them too.
  useEffect(() => {
    if (presentation !== 'v2') return;
    document.documentElement.dataset.shell = 'v2';
    return () => {
      delete document.documentElement.dataset.shell;
    };
  }, [presentation]);
  return presentation;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const fallbackThreadId = getThreadIdFromPathname(pathname);

  useEffect(() => {
    getPlaybackManager();
    return destroyPlaybackRuntime;
  }, []);

  return (
    <>
      <Suspense
        fallback={<ThreadChatRuntimeProvider routeThreadId={fallbackThreadId}>{children}</ThreadChatRuntimeProvider>}
      >
        <AppShellContent pathname={pathname}>{children}</AppShellContent>
      </Suspense>
      <DesktopUpdatePrompt />
    </>
  );
}

function AppShellContent({ children, pathname }: AppShellProps & { pathname: string }) {
  const livePathname = useSyncExternalStore(subscribeBrowserThreadRoute, getBrowserThreadRoutePathname, () => pathname);
  const searchParams = useSearchParams();
  const isExport = searchParams.get('export') === 'true';
  const { isOpen, initialized: sidebarInitialized, open, width, close, handleResize, resetWidth } = useSidebarStore();
  const isDesktop = useIsDesktop();
  const presentation = useShellPresentationFromUrl(pathname, searchParams.get('shell'));
  const isV2 = presentation === 'v2';
  // F322 v2: 记忆 is a Café destination, so its route family keeps the sidebar (and the 记忆 row is the current page).
  // Every other hidden route, classic, and the user's own collapse preference are untouched.
  const isMemoryPagePreview = pathname === '/memory/preview';
  const activeDestination = (isV2 || isMemoryPagePreview) && isMemoryRoute(pathname) ? 'memory' : null;
  const rightPanelMode = useChatStore((state) => state.rightPanelMode);
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

  // A cold load straight into 记忆 (reload, deep link, new tab): only chat routes ever open the sidebar, so nothing
  // has. Apply the desktop default once. `initialized` means something already opened or collapsed it this page
  // load, so a collapse the user made is never undone by arriving here.
  useLayoutEffect(() => {
    if (activeDestination !== null && isDesktop && !sidebarInitialized) open();
  }, [activeDestination, isDesktop, sidebarInitialized, open]);

  if (isExport || isChromeless) {
    if (isChromeless) return <>{children}</>;
    return <ThreadChatRuntimeProvider routeThreadId={routeThreadId}>{children}</ThreadChatRuntimeProvider>;
  }

  const routeHidesSidebar = SIDEBAR_HIDDEN_ROUTES.some((r) => pathname.startsWith(r)) && activeDestination === null;
  const showSidebar = isOpen && isDesktop && !routeHidesSidebar;
  const workspaceVisible = isChatRoute && rightPanelMode === 'workspace';

  return (
    <ThreadChatRuntimeProvider routeThreadId={routeThreadId}>
      <div className="console-shell flex h-screen h-dvh overflow-hidden">
        {isV2 ? worldRail : activityRail}
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
              <ThreadSidebar
                onClose={close}
                className="w-full"
                routeThreadId={routeThreadId}
                activeDestination={activeDestination}
              />
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
        <div className="flex-1 min-w-0 overflow-y-auto" style={isV2 ? { background: 'var(--shell-work)' } : undefined}>
          {children}
        </div>
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
    </ThreadChatRuntimeProvider>
  );
}
