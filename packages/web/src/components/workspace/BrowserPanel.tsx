'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { BrowserTabBar } from './BrowserTabBar';
import { BrowserToolbar } from './BrowserToolbar';
import { ConsolePanel } from './ConsolePanel';
import { parsePreviewUrl } from './preview-url-utils';
import { useHmrStatus } from './useHmrStatus';
import { usePreviewBridge } from './usePreviewBridge';

export interface BrowserTab {
  id: string;
  port: number;
  path: string;
  title: string;
}

interface BrowserPanelProps {
  /** Initial port to preview (e.g. from port discovery toast) */
  initialPort?: number;
  /** Initial path for deep-linking (e.g. "/dashboard" from auto-open) */
  initialPath?: string;
  /** Notify parent when active preview target changes. */
  onNavigate?: (port: number, path: string) => void;
  /** Hide browser chrome so the iframe can occupy the full workspace viewer area. */
  previewOnly?: boolean;
}

interface PreviewStatus {
  available: boolean;
  gatewayPort: number;
}

/**
 * F120: Embedded Browser Panel — previews localhost dev servers via reverse proxy.
 * The iframe loads through the Preview Gateway (独立 origin) to strip X-Frame-Options
 * and isolate cookies/storage from Hub.
 */
export function BrowserPanel({ initialPort, initialPath, onNavigate, previewOnly = false }: BrowserPanelProps) {
  const [gatewayPort, setGatewayPort] = useState<number>(0);
  const [targetPort, setTargetPort] = useState(initialPort ?? 0);
  const [urlInput, setUrlInput] = useState(
    initialPort ? `localhost:${initialPort}${initialPath && initialPath !== '/' ? initialPath : ''}` : '',
  );
  const [targetPath, setTargetPath] = useState(initialPath ?? '/');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const tabIdCounter = useRef(0);
  const hmrStatus = useHmrStatus(gatewayPort, targetPort);
  const { consoleEntries, consoleOpen, setConsoleOpen, isCapturing, screenshotUrl, handleScreenshot, clearConsole } =
    usePreviewBridge(iframeRef, gatewayPort);

  // Helper: update active viewport state
  const activateView = useCallback((port: number, path: string) => {
    setTargetPort(port);
    setTargetPath(path);
    setUrlInput(port ? `localhost:${port}${path !== '/' ? path : ''}` : '');
  }, []);

  // Fetch gateway port on mount
  useEffect(() => {
    apiFetch('/api/preview/status')
      .then((res) => res.json() as Promise<PreviewStatus>)
      .then((data) => {
        if (data.available) setGatewayPort(data.gatewayPort);
      })
      .catch(() => setError('Preview gateway not available'));
  }, []);

  // If initialPort/initialPath changes, add or activate a tab
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

  // Audit: close on unmount only (use ref to avoid stale closure)
  const targetPortRef = useRef(targetPort);
  targetPortRef.current = targetPort;
  useEffect(() => {
    return () => {
      if (targetPortRef.current) {
        apiFetch('/api/preview/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: targetPortRef.current }),
        }).catch(() => {});
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Build gateway URL using URL API to handle paths with query params correctly
  const gatewayUrl = (() => {
    if (!targetPort || !gatewayPort) return '';
    const url = new URL(`http://localhost:${gatewayPort}`);
    // Parse targetPath which may contain query string (e.g. /dashboard?foo=1)
    const qIdx = targetPath.indexOf('?');
    if (qIdx >= 0) {
      url.pathname = targetPath.slice(0, qIdx);
      const existingParams = new URLSearchParams(targetPath.slice(qIdx + 1));
      for (const [k, v] of existingParams) url.searchParams.set(k, v);
    } else {
      url.pathname = targetPath;
    }
    url.searchParams.set('__preview_port', String(targetPort));
    return url.toString();
  })();

  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    onNavigate?.(targetPort, targetPath);
  }, [onNavigate, targetPath, targetPort]);

  const handleNavigate = useCallback(() => {
    setError(null);
    setWarning(null);
    const parsed = parsePreviewUrl(urlInput);
    if (!parsed.valid || !parsed.port) {
      setError(parsed.error ?? 'Enter a valid localhost URL (e.g. localhost:5173)');
      return;
    }
    if (parsed.warning) setWarning(parsed.warning);
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
          setError(data.reason ?? 'Port not allowed');
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
    [activeTabId, activateView],
  );

  const handleTabAdd = useCallback(() => {
    const id = `tab-${++tabIdCounter.current}`;
    setTabs((prev) => [...prev, { id, port: 0, path: '/', title: 'New Tab' }]);
    setActiveTabId(id);
    activateView(0, '/');
  }, [activateView]);

  return (
    <div className="flex flex-col h-full bg-[#FDF8F3]">
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
        />
      )}

      {!previewOnly && hmrStatus !== 'idle' && (
        <div
          className={`flex items-center gap-1.5 px-3 py-1 text-[11px] border-b ${hmrStatus === 'connected' ? 'bg-[#FFF5F2] border-[#FFDDD2]' : 'bg-[#FFF0ED] border-[#FFD4CC]'} text-[#5a4a42]/70`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full inline-block ${hmrStatus === 'connected' ? 'bg-green-500' : 'bg-red-400'}`}
          />
          {hmrStatus === 'connected' ? (
            <span>HMR connected · localhost:{targetPort}</span>
          ) : (
            <span>
              HMR disconnected.{' '}
              <button type="button" className="underline hover:text-[#E29578]" onClick={handleRefresh}>
                Retry
              </button>
            </span>
          )}
        </div>
      )}

      {/* Error banner */}
      {!previewOnly && error && (
        <div className="px-3 py-1.5 text-xs text-red-600 bg-red-50/80 border-b border-red-100">{error}</div>
      )}

      {/* Hub URL warning banner */}
      {!previewOnly && warning && !error && (
        <div className="px-3 py-1.5 text-xs text-amber-700 bg-amber-50/80 border-b border-amber-100">{warning}</div>
      )}

      {/* Screenshot success toast */}
      {!previewOnly && screenshotUrl && (
        <div className="px-3 py-1.5 text-xs text-green-700 bg-green-50/80 border-b border-green-100">
          Screenshot saved:{' '}
          <a href={screenshotUrl} target="_blank" rel="noreferrer" className="underline">
            {screenshotUrl}
          </a>
        </div>
      )}

      {gatewayUrl ? (
        <div className="relative flex-1">
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#FDF8F3]/80 z-10">
              <div className="text-xs text-[#5a4a42]/50">Loading preview...</div>
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={gatewayUrl}
            sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-same-origin"
            referrerPolicy="no-referrer"
            className="w-full h-full border-0"
            title="Preview"
            onLoad={() => setIsLoading(false)}
            onError={() => {
              setIsLoading(false);
              setError('Failed to load preview');
            }}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-[#5a4a42]/40 text-sm text-center">
          <div>
            <div className="text-3xl mb-3 opacity-30">🌐</div>
            <p>Enter a localhost URL to preview</p>
          </div>
        </div>
      )}

      {/* Console panel */}
      {!previewOnly && consoleOpen && <ConsolePanel entries={consoleEntries} onClear={clearConsole} />}

      {!previewOnly && (
        <div className="flex items-center px-2 py-0.5 border-t border-[#FFDDD2] text-[10px] text-[#5a4a42]/40 bg-cafe-surface/40">
          {targetPort && gatewayPort ? (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
              localhost:{targetPort} via gateway:{gatewayPort}
            </span>
          ) : (
            <span>No preview</span>
          )}
        </div>
      )}
    </div>
  );
}
