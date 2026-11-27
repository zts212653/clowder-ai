'use client';

import { useEffect, useState } from 'react';
import { defineShellCopy, useShellCopy } from '@/components/shell/shell-copy';
import type { FileData } from '@/hooks/useWorkspace';
import { apiFetch } from '@/utils/api-client';

const copy = defineShellCopy({
  zh: {
    preview: '网页预览',
    loading: '正在打开网页预览…',
    failed: '无法在应用内预览。可用默认应用打开。',
    missing: '文件不存在。',
    denied: '没有权限读取文件。',
    tooLarge: '文件过大，暂时无法完整渲染。',
  },
  en: {
    preview: 'HTML preview',
    loading: 'Opening HTML preview…',
    failed: 'Preview unavailable. Open the file with its default application.',
    missing: 'The file does not exist.',
    denied: 'You do not have permission to read this file.',
    tooLarge: 'This file is too large to render in full.',
  },
});

function pageDocument(content: string, assetBase: string): string {
  const policy = [
    "default-src 'none'",
    `img-src ${assetBase} data: blob:`,
    `style-src ${assetBase} 'unsafe-inline'`,
    `script-src ${assetBase} 'unsafe-inline'`,
    `font-src ${assetBase} data:`,
    `media-src ${assetBase} blob:`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    `base-uri ${assetBase}`,
  ].join('; ');
  const attribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attribute(policy)}"><base href="${attribute(assetBase)}">${content}`;
}

async function prepareHtmlPreview(worktreeId: string, path: string): Promise<{ id: string; assetPath: string }> {
  // Each mounted preview owns its grant; coordinated GETs cannot share a revocable capability.
  const response = await apiFetch('/api/workspace/html-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worktreeId, path }),
  });
  if (!response.ok)
    throw new Error(response.status === 404 ? 'missing' : response.status === 403 ? 'denied' : 'failed');
  const grant: { id: string; assetPath: string } = await response.json();
  if (
    typeof grant.id !== 'string' ||
    grant.assetPath !== `/api/workspace/html-preview/${encodeURIComponent(grant.id)}/`
  )
    throw new Error('Invalid HTML preview');
  return grant;
}

/** The page receives no cookies, API credentials or unrestricted resource URLs. */
export function WorkspaceHtmlPreview({ worktreeId, path }: { worktreeId: string; path: string }) {
  const t = useShellCopy(copy);
  const [page, setPage] = useState<{ worktreeId: string; path: string; document: string } | null>(null);
  const [failure, setFailure] = useState<'failed' | 'missing' | 'denied' | 'tooLarge' | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let id: string | undefined;
    const revoke = () =>
      id &&
      apiFetch(`/api/workspace/html-preview/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
    setFailure(null);
    void (async () => {
      try {
        const response = await apiFetch('/api/workspace/file?' + new URLSearchParams({ worktreeId, path }), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setFailure(response.status === 404 ? 'missing' : response.status === 403 ? 'denied' : 'failed');
          return;
        }
        const file: FileData = await response.json();
        if (controller.signal.aborted) return;
        if (file.truncated || file.binary) {
          setFailure(file.truncated ? 'tooLarge' : 'failed');
          return;
        }
        const grant = await prepareHtmlPreview(worktreeId, path);
        id = grant.id;
        if (controller.signal.aborted) {
          void revoke();
          return;
        }
        // srcDoc inherits the Hub's script-src 'self'. Use its existing same-origin API proxy for page assets.
        const assetBase = new URL(grant.assetPath, window.location.origin).href;
        setPage({ worktreeId, path, document: pageDocument(file.content, assetBase) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        if (!controller.signal.aborted) setFailure(reason === 'missing' || reason === 'denied' ? reason : 'failed');
      }
    })();
    return () => {
      controller.abort();
      void revoke();
    };
  }, [worktreeId, path]);
  if (failure)
    return (
      <p role="alert" className="p-4 text-sm text-cafe-muted">
        {t[failure]}
      </p>
    );
  if (!page || page.worktreeId !== worktreeId || page.path !== path)
    return <p className="p-4 text-sm text-cafe-muted">{t.loading}</p>;
  return (
    <iframe
      srcDoc={page.document}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={t.preview}
      className="min-h-0 w-full flex-1 border-0 bg-cafe-surface"
    />
  );
}
