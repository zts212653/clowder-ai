'use client';

import { useEffect, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { apiFetch } from '@/utils/api-client';
import { workspaceFileCopy } from './workspace-file.shell-copy';

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
  if (!response.ok) throw new Error('HTML preview unavailable');
  const grant: { id: string; assetPath: string } = await response.json();
  if (
    typeof grant.id !== 'string' ||
    grant.assetPath !== `/api/workspace/html-preview/${encodeURIComponent(grant.id)}/`
  )
    throw new Error('Invalid HTML preview');
  return grant;
}

/** The page receives no cookies, API credentials or unrestricted resource URLs. */
export function WorkspaceHtmlPreview({
  worktreeId,
  path,
  content,
}: {
  worktreeId: string;
  path: string;
  content: string;
}) {
  const t = useShellCopy(workspaceFileCopy);
  const [page, setPage] = useState<{ worktreeId: string; path: string; content: string; document: string } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let closed = false;
    let id: string | undefined;
    const revoke = () =>
      id &&
      apiFetch(`/api/workspace/html-preview/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
    setFailed(false);
    void (async () => {
      try {
        const grant = await prepareHtmlPreview(worktreeId, path);
        id = grant.id;
        if (closed) {
          void revoke();
          return;
        }
        // srcDoc inherits the Hub's script-src 'self'. Use its existing same-origin API proxy for page assets.
        const assetBase = new URL(grant.assetPath, window.location.origin).href;
        setPage({ worktreeId, path, content, document: pageDocument(content, assetBase) });
      } catch {
        if (!closed) setFailed(true);
      }
    })();
    return () => {
      closed = true;
      void revoke();
    };
  }, [worktreeId, path, content]);
  if (failed)
    return (
      <p role="alert" className="p-4 text-sm text-cafe-muted">
        {t.htmlUnavailable}
      </p>
    );
  if (!page || page.worktreeId !== worktreeId || page.path !== path || page.content !== content)
    return <p className="p-4 text-sm text-cafe-muted">{t.htmlLoading}</p>;
  return (
    <iframe
      srcDoc={page.document}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={t.pagePreview}
      className="min-h-0 w-full flex-1 border-0 bg-cafe-surface"
    />
  );
}
