'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { workspaceV3Copy } from '@/components/workspace-home/workspace-v3.shell-copy';
import { API_URL } from '@/utils/api-client';
import { isSiteAssetPath, resolveAssetUrl } from './artifact-view';
export function ArtifactDownloadMenu({ artifact, copyName }: { artifact: ThreadArtifactDTO; copyName?: string }) {
  const t = useShellCopy(workspaceV3Copy);
  const [downloading, setDownloading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  if (!artifact.url) return null;
  const url = resolveAssetUrl(artifact.url, API_URL);
  if (!url) return null;
  const directLink = /^https?:\/\//i.test(artifact.url);
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setFailed(false);
    try {
      const response = await fetch(url, { credentials: isSiteAssetPath(artifact.url) ? 'include' : 'same-origin' });
      if (!response.ok) throw new Error('Work download unavailable');
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = artifact.name;
        link.click();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch {
      setFailed(true);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <details
      className="work-gallery-menu"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }}
    >
      <summary className="shell-focusable" aria-label={t.workActions} title={t.workActions}>
        ⋯
      </summary>
      <a
        href={url}
        download={artifact.name}
        className="shell-focusable"
        aria-disabled={downloading || undefined}
        onClick={(event) => {
          // A readable external link does not imply permission for a cross-origin fetch.
          if (directLink) return;
          event.preventDefault();
          void download();
        }}
      >
        {t.download}
      </a>
      {copyName && (
        <button
          type="button"
          className="shell-focusable"
          aria-label={t.copyFileName}
          onClick={async () => {
            setCopyFailed(false);
            try {
              await navigator.clipboard.writeText(copyName);
            } catch {
              setCopyFailed(true);
            }
          }}
        >
          {t.copyFileName}
        </button>
      )}
      {failed && <output role="alert">{t.downloadFailed}</output>}
      {copyFailed && <output role="alert">{t.copyFileNameFailed}</output>}
    </details>
  );
}
