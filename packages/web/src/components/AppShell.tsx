'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useWorkspaceNavigate } from '@/hooks/useWorkspaceNavigate';
import { destroyPlaybackRuntime, getPlaybackManager } from '@/services/playbackRuntime';
import { CallbackAuthSnapshotMount } from '@/stores/callbackAuthStore';
import { useChatStore } from '@/stores/chatStore';
import { initSidebarWidth, useSidebarStore } from '@/stores/sidebarStore';
import { ActivityBar } from './ActivityBar';
import { ConciergeHost } from './concierge/ConciergeHost';
import { HomeActionHost } from './concierge/HomeActionHost';
import { DesktopUpdatePrompt } from './DesktopUpdatePrompt';
import { FeatureDemoHost } from './FeatureDemoHost';
import { ListenModePlayer } from './listen-mode/ListenModePlayer';
import { reportOnboardingPageLoad } from './onboarding-demo/onboarding-performance';
import { ShellDocumentLanguage } from './shell/ShellDocumentLanguage';
import { isMemoryRoute } from './shell/shell-navigation';
import {
  parseShellPresentation,
  readShellPresentation,
  type ShellPresentation,
  ShellPresentationContext,
  useShellPresentation,
  writeShellPresentation,
} from './shell/shell-presentation';
import { SettingsSourceReturnProvider } from './shell/useSettingsSourceReturn';
import { WorldRail } from './shell/WorldRail';
import { TheaterReplayHost } from './story-player/TheaterReplayHost';
import { ThreadSidebar } from './ThreadSidebar';
import {
  getBrowserThreadRoutePathname,
  getThreadIdFromPathname,
  subscribeBrowserThreadRoute,
} from './ThreadSidebar/thread-navigation';
import { ThreadChatRuntimeProvider } from './thread-chat';
import { useF307ExperienceWorkbenchStore } from './workbench/experience-workbench-store';
import { projectWorkspaceWorkHost } from './workbench/workspace-work-host-projection';
import { FloatingPresentationSurfaceHost } from './workspace/FloatingPresentationSurfaceHost';
import { ResizeHandle } from './workspace/ResizeHandle';

const CHROMELESS_ROUTES = ['/story', '/story-export', '/showcase', '/dev/f277-attention-preview'];

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

// F322 Stage 1: the decided Café 1.6 rail, chosen by the one presentation switch (classic stays as above). It travels with the
// document-language projection because both exist only while the shell is v2: classic never mounts either, so it never reads
// the language and keeps the layout's zh-CN.
const worldRail = (
  <>
    <ShellDocumentLanguage />
    <Suspense fallback={<div className="w-[52px] flex-shrink-0" aria-hidden="true" />}>
      <WorldRail />
    </Suspense>
  </>
);

/**
 * `?shell=v2|classic` is a one-time INTENT attached to a navigation, not a standing instruction. It is applied when the
 * URL is entered — first load, or a client navigation to another route (or to another shell value) — and never again while
 * the user stays on that URL: their own choice (设置与管理 › 主题 › 界面版本) wins even though the query is still in the address bar.
 * A navigation that arrives with the same value on a different route is a fresh intent; re-rendering the current URL is not.
 * Storage stays the truth; the location is only read, not remembered.
 */
function useShellPresentationFromUrl(pathname: string, shellParam: string | null): ShellPresentation {
  const stored = useShellPresentation();
  const requested = parseShellPresentation(shellParam);
  const intent = JSON.stringify([pathname, shellParam]);
  const [appliedIntent, setAppliedIntent] = useState<string | null>(null);
  // Resolve navigation intent in render; do not paint the old shell before writing its preference.
  const presentation = appliedIntent !== intent && requested ? requested : stored;
  useLayoutEffect(() => {
    if (requested && requested !== readShellPresentation()) writeShellPresentation(requested);
    setAppliedIntent(intent);
  }, [intent, requested]);
  // Tokens are scoped to [data-shell="v2"] on <html> so portalled tips/menus get them too.
  useLayoutEffect(() => {
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
        // The fallback must not expose a second interactive route tree. Resolving
        // the shell query replaces this branch, including any embedded iframe.
        fallback={
          <ThreadChatRuntimeProvider routeThreadId={fallbackThreadId}>
            <output
              className="flex h-screen h-dvh items-center justify-center bg-[var(--cafe-surface-canvas)] text-[var(--cafe-text-muted)]"
              aria-busy="true"
            >
              正在打开页面…
            </output>
          </ThreadChatRuntimeProvider>
        }
      >
        <AppShellContent pathname={pathname}>{children}</AppShellContent>
      </Suspense>
      <DesktopUpdatePrompt />
    </>
  );
}

function AppShellContent({ children, pathname }: AppShellProps & { pathname: string }) {
  useEffect(reportOnboardingPageLoad, []);
  // Next can commit the address after this render without emitting either browser route event.
  // Resubscribing checks that committed address while keeping custom thread history as the route owner.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the Next navigation signal that rechecks the browser snapshot
  const subscribeRoute = useCallback((listener: () => void) => subscribeBrowserThreadRoute(listener), [pathname]);
  const livePathname = useSyncExternalStore(subscribeRoute, getBrowserThreadRoutePathname, () => pathname);
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
  const rightPanelOpen = useChatStore((state) => state.rightPanelOpen);
  const workModeRequest = useChatStore((state) => state.workspaceOpenRequest);
  const viewMode = useChatStore((state) => state.viewMode);
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const workLayout = useF307ExperienceWorkbenchStore((state) => state.layout);
  const attentionSurfaceId = useF307ExperienceWorkbenchStore((state) => state.mainAreaAttentionSurfaceId);
  const attentionPresentation = useF307ExperienceWorkbenchStore((state) => state.mainAreaAttentionPresentation);
  const workPresentation = useF307ExperienceWorkbenchStore((state) => state.artifactWorkPresentation);
  const routeThreadId = getThreadIdFromPathname(livePathname);
  const isChatRoute = livePathname === '/' || livePathname.startsWith('/thread/');
  const { suppressCafeSidebar } = projectWorkspaceWorkHost(
    {
      threadId: isChatRoute ? (routeThreadId ?? currentThreadId) : null,
      viewMode,
      isDesktop,
      statusPanelOpen: rightPanelOpen,
      rightPanelMode,
      shellPresentation: presentation,
      workModeRequested:
        isChatRoute &&
        workModeRequest?.threadId === (routeThreadId ?? currentThreadId) &&
        workModeRequest?.presentation === 'work-mode',
    },
    workLayout,
    workPresentation,
    { surfaceId: attentionSurfaceId, presentation: attentionPresentation },
  );
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
    <ShellPresentationContext.Provider value={presentation}>
      <SettingsSourceReturnProvider pathname={livePathname} enabled={isV2}>
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
              <div
                className={`${suppressCafeSidebar ? 'hidden' : 'flex'} items-stretch flex-shrink-0`}
                aria-hidden={suppressCafeSidebar || undefined}
              >
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
            <div
              className="flex-1 min-w-0 overflow-y-auto"
              style={isV2 ? { background: 'var(--shell-work)' } : undefined}
            >
              {children}
            </div>
            <ListenModePlayer variant="mini" workspaceVisible={workspaceVisible} />
            {/* F226: presentation surface floating window — mounted at AppShell root (outside route
          children) so the float survives both workspace mode-tab switches AND full-page route
          changes (/memory, /settings, /mission-hub). KD-1. */}
            <FloatingPresentationSurfaceHost />
            {/* Shared companion config and desktop presence survive route changes.
          This initializer renders no web body; the rail opens the original conversation. */}
            <ConciergeHost />
            <FeatureDemoHost />
            <HomeActionHost enabled={!isExport} />
            {/* F246 Phase C: Approval Hub moved to workspace panel tab — drawer removed */}
          </div>
        </ThreadChatRuntimeProvider>
      </SettingsSourceReturnProvider>
    </ShellPresentationContext.Provider>
  );
}
