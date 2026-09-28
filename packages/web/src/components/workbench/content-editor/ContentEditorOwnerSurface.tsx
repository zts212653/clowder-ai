'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '@/utils/api-client';
import type { ContentEditorTarget } from '../real-surface-adapters';
import { attachEditorBridgePort } from './bridge-client';

interface EditorAdmission {
  readonly sessionRef: string;
  readonly sessionToken: string;
  readonly rendererUrl: string;
  readonly rendererOrigin: string;
  readonly surfaceIntegrity: string;
  readonly bridgeVersion: '1.0.0';
}

interface MountedEditorAdmission extends EditorAdmission {
  readonly handshakeNonce: string;
}

export function ContentEditorOwnerSurface({
  target,
  apiBase = API_URL,
  fetchImpl = fetch,
  handshakeTimeoutMs = 10_000,
  onRetry,
}: {
  readonly target: ContentEditorTarget;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
  readonly handshakeTimeoutMs?: number;
  readonly onRetry?: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const disconnectRef = useRef<(() => void) | null>(null);
  const connectedRef = useRef(false);
  const revokedRef = useRef(false);
  const loadCountRef = useRef(0);
  const [admission, setAdmission] = useState<MountedEditorAdmission | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'connected' | 'unavailable'>('loading');
  const [disconnected, setDisconnected] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    disconnectRef.current?.();
    disconnectRef.current = null;
    connectedRef.current = false;
    revokedRef.current = false;
    loadCountRef.current = 0;
    setAdmission(null);
    setState('loading');
    setDisconnected(false);
    void fetchImpl(
      `${normalizeApiBase(apiBase)}/api/collaborative-content/editor-sessions/${encodeURIComponent(target.sessionRef)}/resume`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('editor session resume failed');
        const value: unknown = await response.json();
        const next = parseAdmission(value, target.sessionRef, apiBase);
        if (!next) throw new Error('editor admission response is invalid');
        if (!controller.signal.aborted) {
          setAdmission({ ...next, handshakeNonce: createHandshakeNonce() });
          setState('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('unavailable');
      });
    return () => controller.abort();
  }, [apiBase, fetchImpl, target.sessionRef]);

  useEffect(
    () => () => {
      disconnectRef.current?.();
      disconnectRef.current = null;
    },
    [],
  );

  const revokeSurface = useCallback(() => {
    revokedRef.current = true;
    if (connectedRef.current) {
      disconnectRef.current?.();
      disconnectRef.current = null;
      connectedRef.current = false;
    }
    setState('unavailable');
    void fetchImpl(
      `${normalizeApiBase(apiBase)}/api/collaborative-content/editor-sessions/${encodeURIComponent(target.sessionRef)}`,
      { method: 'DELETE', credentials: 'include' },
    ).catch(() => undefined);
  }, [apiBase, fetchImpl, target.sessionRef]);

  useEffect(() => {
    if (!admission || state !== 'ready') return;
    const timeout = window.setTimeout(() => {
      if (!connectedRef.current) revokeSurface();
    }, handshakeTimeoutMs);
    return () => window.clearTimeout(timeout);
  }, [admission, handshakeTimeoutMs, revokeSurface, state]);

  useEffect(() => {
    if (!admission) return;
    const receiveReady = (event: MessageEvent<unknown>): void => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (
        revokedRef.current ||
        connectedRef.current ||
        !frameWindow ||
        event.source !== frameWindow ||
        event.origin !== admission.rendererOrigin ||
        !isReadyMessage(event.data, admission)
      ) {
        return;
      }
      const channel = new MessageChannel();
      disconnectRef.current = attachEditorBridgePort(channel.port1, {
        expectedSessionToken: admission.sessionToken,
        apiBase: normalizeApiBase(apiBase),
        fetchImpl,
        onUnavailable: () => setDisconnected(true),
      });
      connectedRef.current = true;
      frameWindow.postMessage(
        {
          v: 1,
          kind: 'cat-cafe-content-editor-connect',
          bridgeVersion: admission.bridgeVersion,
          sessionToken: admission.sessionToken,
          handshakeNonce: admission.handshakeNonce,
        },
        admission.rendererOrigin,
        [channel.port2],
      );
      setState('connected');
    };
    window.addEventListener('message', receiveReady);
    return () => window.removeEventListener('message', receiveReady);
  }, [admission, apiBase, fetchImpl]);

  const handleLoad = useCallback(() => {
    loadCountRef.current += 1;
    if (loadCountRef.current > 1) revokeSurface();
  }, [revokeSurface]);

  if (state === 'unavailable') {
    return (
      <div className="grid h-full min-h-52 place-items-center p-6 text-center" data-testid="content-editor-unavailable">
        <div>
          <p className="text-sm font-semibold text-cafe">编辑器暂不可用</p>
          <p className="mt-1 max-w-sm text-xs leading-5 text-cafe-muted">
            编辑器连接已中断，已保存的文档仍保留。请重新打开；若仍无法连接，可在插件设置中修复 GenOffice。
          </p>
          <div className="mt-3 flex justify-center gap-4 text-sm text-cafe-accent">
            {onRetry && (
              <button type="button" onClick={onRetry}>
                重新打开文档
              </button>
            )}
            <a href="/settings?s=plugins">打开插件设置</a>
          </div>
        </div>
      </div>
    );
  }

  if (!admission) {
    return <div className="p-5 text-xs text-cafe-muted">正在恢复文档连接…</div>;
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-1 flex-col" data-testid={`content-editor-${state}`}>
      {disconnected && (
        <div
          className="border-b border-cafe-border bg-cafe-card px-4 py-3 text-sm text-cafe"
          data-testid="content-editor-disconnected"
          role="status"
        >
          连接已中断，暂时无法保存；未保存的修改仍留在下方编辑器中。重新打开会恢复上次保存的版本。
          <a href="/settings?s=plugins" className="ml-2 text-cafe-accent underline">
            打开插件设置
          </a>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={rendererSrc(admission)}
        title={`DOCX editor · ${target.contentRef}`}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        className="h-full min-h-0 w-full border-0"
        onLoad={handleLoad}
      />
    </div>
  );
}

function parseAdmission(value: unknown, expectedSessionRef: string, apiBase: string): EditorAdmission | null {
  if (!isRecord(value) || !isRecord(value.surface)) return null;
  const surface = value.surface;
  if (!isRecord(surface.framingPolicy)) return null;
  const framingPolicy = surface.framingPolicy;
  if (
    value.sessionRef !== expectedSessionRef ||
    typeof value.sessionToken !== 'string' ||
    value.sessionToken.length < 32 ||
    value.sessionToken.length > 256 ||
    surface.v !== 1 ||
    surface.kind !== 'f202-content-editor-surface-admission' ||
    !isBoundedToken(surface.providerId) ||
    !isBoundedToken(surface.installationInstanceId) ||
    !isBoundedToken(surface.providerVersion) ||
    !isBoundedToken(surface.packageDigest) ||
    !Number.isSafeInteger(surface.grantRevision) ||
    Number(surface.grantRevision) < 1 ||
    !Number.isSafeInteger(surface.lifecycleRevision) ||
    Number(surface.lifecycleRevision) < 1 ||
    surface.activationState !== 'enabled' ||
    surface.runtimeState !== 'healthy' ||
    typeof surface.rendererOrigin !== 'string' ||
    typeof surface.entrypointPath !== 'string' ||
    typeof surface.surfaceIntegrity !== 'string' ||
    !/^sha256-[A-Za-z0-9+/]{43}=$/.test(surface.surfaceIntegrity) ||
    surface.bridgeVersion !== '1.0.0' ||
    surface.sandbox !== 'dedicated-origin-iframe' ||
    surface.navigationPolicy !== 'navigation-api-deny' ||
    framingPolicy.kind !== 'csp-frame-ancestors' ||
    framingPolicy.parentOrigin !== window.location.origin
  ) {
    return null;
  }
  try {
    const rendererOrigin = new URL(surface.rendererOrigin);
    const rendererUrl = new URL(surface.entrypointPath, rendererOrigin);
    const apiOrigin = new URL(normalizeApiBase(apiBase), window.location.href).origin;
    if (
      rendererOrigin.origin !== surface.rendererOrigin ||
      !isAllowedRendererOrigin(rendererUrl) ||
      rendererUrl.origin === window.location.origin ||
      rendererUrl.origin === apiOrigin ||
      rendererUrl.username !== '' ||
      rendererUrl.password !== '' ||
      rendererUrl.search !== '' ||
      rendererUrl.hash !== '' ||
      !/^\/packages\/[A-Za-z0-9._~-]+\/assets\/[A-Za-z0-9._~/-]+$/.test(rendererUrl.pathname) ||
      rendererUrl.pathname.includes('..')
    ) {
      return null;
    }
    return {
      sessionRef: value.sessionRef,
      sessionToken: value.sessionToken,
      rendererUrl: rendererUrl.href,
      rendererOrigin: rendererUrl.origin,
      surfaceIntegrity: surface.surfaceIntegrity,
      bridgeVersion: surface.bridgeVersion,
    };
  } catch {
    return null;
  }
}

function rendererSrc(admission: MountedEditorAdmission): string {
  const url = new URL(admission.rendererUrl);
  const params = new URLSearchParams({
    'cat-cafe-parent-origin': window.location.origin,
    'cat-cafe-handshake': admission.handshakeNonce,
  });
  url.hash = params.toString();
  return url.href;
}

function createHandshakeNonce(): string {
  return `handshake_${window.crypto.randomUUID().replaceAll('-', '')}`;
}

function isReadyMessage(value: unknown, admission: MountedEditorAdmission): boolean {
  return (
    isRecord(value) &&
    value.v === 1 &&
    value.kind === 'cat-cafe-content-editor-ready' &&
    value.bridgeVersion === admission.bridgeVersion &&
    value.handshakeNonce === admission.handshakeNonce
  );
}

function isAllowedRendererOrigin(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname.endsWith('.localhost'))
  );
}

function normalizeApiBase(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function isBoundedToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !value.includes('\0')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
