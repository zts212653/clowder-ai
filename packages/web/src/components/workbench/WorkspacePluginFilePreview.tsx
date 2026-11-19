'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { FileActions } from '@/components/content-review/FileActions';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ContentLandingHeader } from './content-review/ContentLandingHeader';

type Preview = {
  rendererOrigin: string;
  entrypointPath: string;
  fileName: string;
  mediaType: string;
  bytesBase64: string;
};
type PreviewState = 'loading' | 'unavailable' | 'failed' | { preview: Omit<Preview, 'bytesBase64'>; nonce: string };

function parsePreview(input: unknown): Preview {
  if (!input || typeof input !== 'object') throw new Error('invalid preview response');
  const record = input as Record<string, unknown>;
  const { rendererOrigin, entrypointPath, fileName, mediaType, bytesBase64 } = record;
  if (
    typeof rendererOrigin !== 'string' ||
    !/^http:\/\/editor-[a-f0-9]{32}\.localhost:[0-9]+$/.test(rendererOrigin) ||
    typeof entrypointPath !== 'string' ||
    !/^\/packages\/[a-f0-9-]+\/assets\/[A-Za-z0-9._~/-]+\.html$/.test(entrypointPath) ||
    typeof fileName !== 'string' ||
    typeof mediaType !== 'string' ||
    typeof bytesBase64 !== 'string'
  ) {
    throw new Error('invalid preview response');
  }
  return { rendererOrigin, entrypointPath, fileName, mediaType, bytesBase64 };
}

export function WorkspacePluginFilePreview({
  target,
  navigationOrigin,
  onBack,
  showPluginSettings,
  fallback,
}: {
  target: { worktreeId: string; path: string };
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  onBack: () => void;
  showPluginSettings: boolean;
  fallback: ReactNode;
}) {
  const [state, setState] = useState<PreviewState>('loading');
  const frame = useRef<HTMLIFrameElement>(null);
  const payload = useRef<ArrayBuffer | null>(null);
  const { worktreeId, path } = target;
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch('/api/workspace/content-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worktreeId, path }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 204) {
          if (!controller.signal.aborted) setState('unavailable');
          return;
        }
        if (!response.ok) throw new Error('preview unavailable');
        const { bytesBase64, ...preview } = parsePreview(await response.json());
        if (controller.signal.aborted) return;
        payload.current = Uint8Array.from(atob(bytesBase64), (character) => character.charCodeAt(0)).buffer;
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
          value.toString(16).padStart(2, '0'),
        ).join('');
        setState({ preview, nonce: `handshake_${nonce}` });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('failed');
      });
    return () => {
      controller.abort();
      payload.current = null;
    };
  }, [worktreeId, path]);

  useEffect(() => {
    if (typeof state === 'string') return;
    const { preview, nonce } = state;
    const receiveReady = (event: MessageEvent<unknown>) => {
      const recipient = frame.current?.contentWindow;
      if (!recipient || event.source !== recipient || event.origin !== preview.rendererOrigin || !payload.current)
        return;
      const message = event.data;
      if (typeof message !== 'object' || message === null) return;
      const ready = message as Record<string, unknown>;
      if (ready.v !== 1 || ready.kind !== 'cat-cafe-content-preview-ready' || ready.handshakeNonce !== nonce) return;

      const bytes = payload.current;
      payload.current = null;
      const { port1, port2 } = new MessageChannel();
      recipient.postMessage(
        { v: 1, kind: 'cat-cafe-content-preview-connect', handshakeNonce: nonce },
        preview.rendererOrigin,
        [port2],
      );
      port1.postMessage(
        {
          v: 1,
          kind: 'cat-cafe-content-preview-snapshot',
          fileName: preview.fileName,
          mediaType: preview.mediaType,
          bytes,
        },
        [bytes],
      );
      port1.close();
    };
    window.addEventListener('message', receiveReady);
    const timer = window.setTimeout(() => {
      if (payload.current) {
        payload.current = null;
        setState('failed');
      }
    }, 10_000);
    return () => {
      window.removeEventListener('message', receiveReady);
      window.clearTimeout(timer);
    };
  }, [state]);

  if (state === 'unavailable' || state === 'failed') {
    if (!showPluginSettings && state === 'unavailable') return fallback;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <output className="shrink-0 px-3 py-2 text-xs text-cafe-muted">
          {state === 'failed' ? '无法加载文件预览。可用默认应用打开。' : '暂无可用的预览插件。可用默认应用打开。'}
          {showPluginSettings && (
            <a className="ml-2 text-cafe-accent hover:underline" href="/settings?s=plugins">
              插件设置
            </a>
          )}
        </output>
        {fallback}
      </div>
    );
  }
  const title = path.split('/').at(-1) || path;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContentLandingHeader
        title={title}
        navigationOrigin={navigationOrigin}
        onBack={onBack}
        leadingAction={
          <FileActions source={{ kind: 'workspace', worktreeId, path }} filename={title} appearance="toolbar" />
        }
      />
      {state === 'loading' ? (
        <output className="p-4 text-xs text-cafe-muted">正在打开预览…</output>
      ) : (
        <iframe
          ref={frame}
          title={state.preview.fileName}
          className="min-h-0 w-full flex-1 border-0"
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          src={`${state.preview.rendererOrigin}${state.preview.entrypointPath}#${new URLSearchParams({
            'cat-cafe-parent-origin': window.location.origin,
            'cat-cafe-handshake': state.nonce,
          })}`}
        />
      )}
    </div>
  );
}
