'use client';

import { buildPreviewGatewayUrl } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { previewVisiblePageAdmissionController } from '@/lib/preview-visible-page-admission-controller';
import { apiFetch } from '@/utils/api-client';
import type { DemoPreviewStage } from '../onboarding-demo/demo-story';
import { BrowserTabBar } from './BrowserTabBar';
import { BrowserToolbar } from './BrowserToolbar';
import { BundledDemoBrowser } from './BundledDemoBrowser';
import { ConsolePanel } from './ConsolePanel';
import { type CodeToolsCopy, codeToolsCopy } from './code-tools.shell-copy';
import { parsePreviewUrl } from './preview-url-utils';
import { useHmrStatus } from './useHmrStatus';
import { usePreviewBridge } from './usePreviewBridge';

type PreviewCopy = CodeToolsCopy['preview'];

const CLASSIC_COPY: PreviewCopy = {
  back: 'Back',
  forward: 'Forward',
  refresh: 'Refresh',
  go: 'Go',
  screenshot: 'Capture Screenshot',
  consoleToggle: 'Toggle Console',
  newTab: 'New tab',
  newTabTitle: 'New Tab',
  gatewayUnavailable: 'Preview gateway not available',
  invalidUrl: 'Enter a valid localhost URL (e.g. localhost:5173)',
  hubPageWarning:
    'This URL looks like a Clowder AI Hub page, not a dev server. Preview is designed for dev servers (Vite, Next.js, etc.).',
  portNotAllowed: 'Port not allowed',
  hmrConnected: (port: number) => `HMR connected · localhost:${port}`,
  hmrDisconnected: 'HMR disconnected.',
  hmrRetry: 'Retry',
  screenshotSaved: 'Screenshot saved:',
  loading: 'Loading preview...',
  loadFailed: 'Failed to load preview',
  emptyPrompt: 'Enter a localhost URL to preview',
  targetStopped: (port: number) => `localhost:${port} stopped / unavailable`,
  targetUnreachableTitle: (port: number) => `localhost:${port} 无响应 — preview 目标已停止或不可达`,
  retryRecover: '重试恢复',
  viaGateway: (target: number, gateway: number) => `localhost:${target} via gateway:${gateway}`,
  noPreview: 'No preview',
  iframeTitle: 'Preview',
};

export interface BrowserTab {
  id: string;
  port: number;
  path: string;
  /** null = the locale default at render time; a real address or user title is data and stays. */
  title: string | null;
}

interface BrowserPanelProps {
  /** Fixed, packaged onboarding deliverable. Does not start or probe a runtime. */
  bundledPage?: 'onboarding-todo';
  bundledStage?: DemoPreviewStage;
  onBundledReady?: () => void;
  /** Initial port to preview (e.g. from port discovery toast) */
  initialPort?: number;
  /** Initial path for deep-linking (e.g. "/dashboard" from auto-open) */
  initialPath?: string;
  /** Hide toolbar/tabs/console — used in focus mode */
  previewOnly?: boolean;
  /** Called when user navigates to a new port/path — keeps parent state in sync */
  onNavigate?: (port: number, path: string) => void;
}

interface PreviewStatus {
  available: boolean;
  gatewayPort: number;
}

/** Local, translatable feedback is kept as a semantic issue and worded at render time; server text passes through. */
type PreviewIssue =
  | { kind: 'gateway_unavailable' }
  | { kind: 'invalid_url' }
  | { kind: 'load_failed' }
  | { kind: 'port_not_allowed' }
  | { kind: 'server'; text: string };

function previewIssueText(issue: PreviewIssue, copy: PreviewCopy): string {
  switch (issue.kind) {
    case 'gateway_unavailable':
      return copy.gatewayUnavailable;
    case 'invalid_url':
      return copy.invalidUrl;
    case 'load_failed':
      return copy.loadFailed;
    case 'port_not_allowed':
      return copy.portNotAllowed;
    case 'server':
      return issue.text;
  }
}

export function BrowserPanel(props: BrowserPanelProps) {
  const presentation = useShellPresentation();
  if (props.bundledPage === 'onboarding-todo')
    return <BundledDemoBrowser stage={props.bundledStage} onReady={props.onBundledReady} />;
  return presentation === 'v2' ? <BrowserPanelV2 {...props} /> : <BrowserPanelCore {...props} copy={CLASSIC_COPY} />;
}

function BrowserPanelV2(props: BrowserPanelProps) {
  const copy = useShellCopy(codeToolsCopy).preview;
  return <BrowserPanelCore {...props} copy={copy} />;
}

/**
 * F120: Embedded Browser Panel — previews localhost dev servers via reverse proxy.
 * The iframe loads through the Preview Gateway (独立 origin) to strip X-Frame-Options
 * and isolate cookies/storage from Hub.
 */
function BrowserPanelCore({
  initialPort,
  initialPath,
  previewOnly,
  onNavigate,
  copy,
}: BrowserPanelProps & { copy: PreviewCopy }) {
  const [gatewayPort, setGatewayPort] = useState<number>(0);
  const [targetPort, setTargetPort] = useState(initialPort ?? 0);
  const [urlInput, setUrlInput] = useState(
    initialPort ? `localhost:${initialPort}${initialPath && initialPath !== '/' ? initialPath : ''}` : '',
  );
  const [targetPath, setTargetPath] = useState(initialPath ?? '/');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<PreviewIssue | null>(null);
  const [warning, setWarning] = useState<'hub_page' | null>(null);
  // F120 × F284: liveness of the preview target. A restored preview whose dev
  // server died must show an explicit stopped state, never an error-shell iframe.
  const [targetHealth, setTargetHealth] = useState<'checking' | 'reachable' | 'unreachable' | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loadedGatewayUrl, setLoadedGatewayUrl] = useState<string | null>(null);
  const tabIdCounter = useRef(0);
  const gatewayReadStarted = useRef(false);
  const surfaceVisible = useWorkspaceSurfaceVisibility();
  const hmrStatus = useHmrStatus(gatewayPort, targetPort, surfaceVisible);
  const pendingVisiblePageAdmission = useSyncExternalStore(
    previewVisiblePageAdmissionController.subscribe,
    previewVisiblePageAdmissionController.getSnapshot,
    () => null,
  );
  const {
    consoleEntries,
    consoleOpen,
    setConsoleOpen,
    isCapturing,
    screenshotUrl,
    handleScreenshot,
    clearConsole,
    requestVisiblePageAttestation,
  } = usePreviewBridge(iframeRef, gatewayPort, targetPort, previewVisiblePageAdmissionController.attest);

  const activateView = useCallback((port: number, path: string) => {
    setTargetPort(port);
    setTargetPath(path);
    setUrlInput(port ? `localhost:${port}${path !== '/' ? path : ''}` : '');
  }, []);

  useEffect(() => {
    if (onNavigate) onNavigate(targetPort, targetPath);
  }, [targetPort, targetPath, onNavigate]);

  // F120 × F284: probe target liveness whenever the target port changes.
  // Dead dev server → stopped/unavailable UI with a retry action; reachable →
  // the iframe loads through the gateway as before.
  const probeSeq = useRef(0);
  const lastProbedPort = useRef(0);
  const probeTarget = useCallback((port: number, preserveExisting = false) => {
    const seq = ++probeSeq.current;
    if (!preserveExisting) setTargetHealth('checking');
    apiFetch(`/api/preview/target-health?port=${port}`)
      .then((res) => res.json() as Promise<{ reachable?: boolean }>)
      .then((data) => {
        if (probeSeq.current !== seq) return;
        setTargetHealth(data.reachable ? 'reachable' : 'unreachable');
        if (!data.reachable) setIsLoading(false);
      })
      .catch(() => {
        if (probeSeq.current !== seq) return;
        setTargetHealth('unreachable');
        setIsLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!targetPort) {
      setTargetHealth(null);
      return;
    }
    if (!surfaceVisible) return;
    const preserveExisting = lastProbedPort.current === targetPort;
    lastProbedPort.current = targetPort;
    probeTarget(targetPort, preserveExisting);
  }, [targetPort, probeTarget, surfaceVisible]);

  const handleRetryProbe = useCallback(() => {
    if (targetPort) probeTarget(targetPort);
  }, [targetPort, probeTarget]);

  // Fetch gateway port on mount
  useEffect(() => {
    if (!surfaceVisible || gatewayReadStarted.current) return;
    gatewayReadStarted.current = true;
    apiFetch('/api/preview/status')
      .then((res) => res.json() as Promise<PreviewStatus>)
      .then((data) => {
        if (data.available) setGatewayPort(data.gatewayPort);
      })
      .catch(() => {
        gatewayReadStarted.current = false;
        setError({ kind: 'gateway_unavailable' });
      });
  }, [surfaceVisible]);

  useEffect(() => {
    if (!initialPort) return;
    const path = initialPath ?? '/';
    const title = `localhost:${initialPort}${path !== '/' ? path : ''}`;
    // Find existing tab with same port
    // Use functional update to guard against React Strict Mode double execution.
    // The find check inside setTabs ensures we never create a duplicate tab.
    setTabs((prev) => {
      const existing = prev.find((t) => t.port === initialPort);
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      const id = `tab-${++tabIdCounter.current}`;
      setActiveTabId(id);
      return [...prev, { id, port: initialPort, path, title }];
    });
    activateView(initialPort, path);
  }, [initialPort, initialPath, activateView]); // eslint-disable-line react-hooks/exhaustive-deps

  const gatewayUrl = (() => {
    if (!targetPort || !gatewayPort) return '';
    return buildPreviewGatewayUrl(gatewayPort, targetPort, targetPath);
  })();

  const requestPendingVisiblePageAdmission = useCallback(() => {
    if (
      !surfaceVisible ||
      !pendingVisiblePageAdmission ||
      pendingVisiblePageAdmission.port !== targetPort ||
      pendingVisiblePageAdmission.path !== targetPath ||
      loadedGatewayUrl !== gatewayUrl
    ) {
      return;
    }
    requestVisiblePageAttestation(pendingVisiblePageAdmission);
  }, [
    gatewayUrl,
    loadedGatewayUrl,
    pendingVisiblePageAdmission,
    requestVisiblePageAttestation,
    surfaceVisible,
    targetPath,
    targetPort,
  ]);

  useEffect(() => {
    if (targetHealth === 'reachable' && gatewayUrl && iframeRef.current) {
      requestPendingVisiblePageAdmission();
    }
  }, [gatewayUrl, requestPendingVisiblePageAdmission, targetHealth]);

  useEffect(() => {
    if (
      surfaceVisible &&
      targetHealth === 'unreachable' &&
      pendingVisiblePageAdmission?.port === targetPort &&
      pendingVisiblePageAdmission.path === targetPath
    ) {
      previewVisiblePageAdmissionController.fail(pendingVisiblePageAdmission.eventId, 'visible_page_unavailable');
    }
  }, [pendingVisiblePageAdmission, surfaceVisible, targetHealth, targetPath, targetPort]);

  const handleNavigate = useCallback(() => {
    setError(null);
    setWarning(null);
    const parsed = parsePreviewUrl(urlInput);
    if (!parsed.valid || !parsed.port) {
      setError({ kind: 'invalid_url' });
      return;
    }
    if (parsed.warning) {
      setWarning('hub_page');
    }
    const port = parsed.port;
    const path = parsed.path ?? '/';
    // Audit: validate + open via backend
    apiFetch('/api/preview/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    })
      .then((res) => res.json() as Promise<{ allowed: boolean; reason?: string }>)
      .then((data) => {
        if (!data.allowed) {
          setError(data.reason ? { kind: 'server', text: data.reason } : { kind: 'port_not_allowed' });
          return;
        }
        // Audit navigate if path changed
        if (path !== '/') {
          apiFetch('/api/preview/navigate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port, url: path }),
          }).catch(() => {});
        }
        setTargetPort(port);
        setTargetPath(path);
        setIsLoading(true);
        // Sync active tab
        if (activeTabId) {
          const title = `localhost:${port}${path !== '/' ? path : ''}`;
          setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, port, path, title } : t)));
        }
      })
      .catch(() => {
        setTargetPort(port);
        setTargetPath(path);
        setIsLoading(true);
      });
  }, [urlInput, activeTabId]);

  const handleBack = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.history.back();
    } catch {
      // cross-origin fallback — no-op
    }
  }, []);

  const handleForward = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.history.forward();
    } catch {
      // cross-origin fallback — no-op
    }
  }, []);

  const handleRefresh = useCallback(() => {
    if (iframeRef.current && gatewayUrl) {
      setIsLoading(true);
      const src = iframeRef.current.src;
      iframeRef.current.src = '';
      requestAnimationFrame(() => {
        if (iframeRef.current) iframeRef.current.src = src;
      });
    }
  }, [gatewayUrl]);

  const handleTabSelect = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      setActiveTabId(tabId);
      activateView(tab.port, tab.path);
    },
    [tabs, activateView],
  );

  const handleTabClose = useCallback(
    (tabId: string) => {
      const closingTab = tabs.find((tab) => tab.id === tabId);
      const portStillOpen = closingTab ? tabs.some((tab) => tab.id !== tabId && tab.port === closingTab.port) : false;

      // F284: collapsing or switching the Workspace shell may unmount this
      // component, but that is not user intent to terminate a live preview.
      // Only an explicit tab close owns the backend lifecycle transition.
      if (closingTab?.port && !portStillOpen) {
        void apiFetch('/api/preview/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: closingTab.port }),
        }).catch(() => {});
      }

      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        if (activeTabId === tabId) {
          const fallback = next[next.length - 1];
          if (fallback) {
            setActiveTabId(fallback.id);
            activateView(fallback.port, fallback.path);
          } else {
            setActiveTabId(null);
            activateView(0, '/');
          }
        }
        return next;
      });
    },
    [activeTabId, activateView, tabs],
  );

  const handleTabAdd = useCallback(() => {
    const id = `tab-${++tabIdCounter.current}`;
    setTabs((prev) => [...prev, { id, port: 0, path: '/', title: null }]);
    setActiveTabId(id);
    activateView(0, '/');
  }, [activateView]);

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col bg-[var(--ws-surface)]">
      {!previewOnly && (
        <BrowserToolbar
          urlInput={urlInput}
          onUrlChange={setUrlInput}
          onNavigate={handleNavigate}
          onBack={handleBack}
          onForward={handleForward}
          onRefresh={handleRefresh}
          onScreenshot={handleScreenshot}
          isCapturing={isCapturing}
          hasTarget={!!targetPort}
          consoleOpen={consoleOpen}
          onConsoleToggle={() => setConsoleOpen((v) => !v)}
          consoleCount={consoleEntries.length}
          copy={copy}
        />
      )}

      {/* Tab bar — only show when there are tabs */}
      {!previewOnly && tabs.length > 0 && (
        <BrowserTabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={handleTabSelect}
          onClose={handleTabClose}
          onAdd={handleTabAdd}
          defaultTitle={copy.newTabTitle}
          addTitle={copy.newTab}
        />
      )}

      {!previewOnly && hmrStatus !== 'idle' && (
        <div
          className={`flex items-center gap-1.5 px-3 py-1 text-xs border-b ${hmrStatus === 'connected' ? 'bg-[var(--ws-surface-hover)] border-[var(--console-border-soft)]' : 'bg-[var(--ws-surface-alert)] border-[var(--console-border-soft)]'} text-[var(--ws-text)]/70`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full inline-block ${hmrStatus === 'connected' ? 'bg-conn-green-text' : 'bg-[var(--semantic-critical)]'}`}
          />
          {hmrStatus === 'connected' ? (
            <span>{copy.hmrConnected(targetPort)}</span>
          ) : (
            <span>
              {copy.hmrDisconnected}{' '}
              <button type="button" className="underline hover:text-[var(--ws-accent)]" onClick={handleRefresh}>
                {copy.hmrRetry}
              </button>
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="px-3 py-1.5 text-xs text-conn-red-text bg-conn-red-bg/80 border-b border-[var(--semantic-critical-surface)]">
          {previewIssueText(error, copy)}
        </div>
      )}
      {warning && !error && (
        <div className="px-3 py-1.5 text-xs text-conn-amber-text bg-conn-amber-bg/80 border-b border-[var(--semantic-warning-surface)]">
          {copy.hubPageWarning}
        </div>
      )}
      {screenshotUrl && (
        <div className="px-3 py-1.5 text-xs text-conn-green-text bg-conn-green-bg/80 border-b border-[var(--semantic-success-surface)]">
          {copy.screenshotSaved}{' '}
          <a href={screenshotUrl} target="_blank" rel="noreferrer" className="underline">
            {screenshotUrl}
          </a>
        </div>
      )}

      {targetPort && targetHealth === 'unreachable' ? (
        <div
          data-testid="preview-unavailable"
          className="flex-1 flex items-center justify-center text-[var(--ws-text)]/60 text-sm text-center"
        >
          <div>
            <p>{copy.targetUnreachableTitle(targetPort)}</p>
            <button
              type="button"
              className="mt-3 px-3 py-1 text-xs rounded border border-[var(--console-border-soft)] hover:text-[var(--ws-accent)]"
              onClick={handleRetryProbe}
            >
              {copy.retryRecover}
            </button>
          </div>
        </div>
      ) : gatewayUrl && targetHealth === 'reachable' ? (
        <div className="relative flex-1">
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--ws-surface)]/80 z-10">
              <div className="text-xs text-[var(--ws-text)]/50">{copy.loading}</div>
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={gatewayUrl}
            sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-same-origin"
            referrerPolicy="no-referrer"
            className="w-full h-full border-0"
            title={copy.iframeTitle}
            onLoad={() => {
              setIsLoading(false);
              setLoadedGatewayUrl(gatewayUrl);
            }}
            onError={() => {
              setIsLoading(false);
              setLoadedGatewayUrl(null);
              setError({ kind: 'load_failed' });
              if (pendingVisiblePageAdmission?.port === targetPort && pendingVisiblePageAdmission.path === targetPath) {
                previewVisiblePageAdmissionController.fail(
                  pendingVisiblePageAdmission.eventId,
                  'visible_page_load_error',
                );
              }
            }}
          />
        </div>
      ) : targetPort ? (
        <div className="flex-1 flex items-center justify-center bg-[var(--ws-surface)]/80">
          <div className="text-xs text-[var(--ws-text)]/50">{copy.loading}</div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-[var(--ws-text)]/40 text-sm text-center">
          <div>
            <div className="text-3xl mb-3 opacity-30">🌐</div>
            <p>{copy.emptyPrompt}</p>
          </div>
        </div>
      )}

      {/* Console panel */}
      {!previewOnly && consoleOpen && <ConsolePanel entries={consoleEntries} onClear={clearConsole} />}

      {!previewOnly && (
        <div className="flex items-center px-2 py-0.5 console-divider-t text-micro text-[var(--ws-text)]/40 bg-cafe-surface/40">
          {targetPort && gatewayPort && targetHealth === 'unreachable' ? (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--semantic-critical)] inline-block" />
              {copy.targetStopped(targetPort)}
            </span>
          ) : targetPort && gatewayPort ? (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-conn-green-text inline-block" />
              {copy.viaGateway(targetPort, gatewayPort)}
            </span>
          ) : (
            <span>{copy.noPreview}</span>
          )}
        </div>
      )}
    </div>
  );
}
