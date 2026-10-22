import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useState } from 'react';
import { classifyArtifactView, isSiteAssetPath, resolveAssetUrl } from '@/components/artifacts/artifact-view';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useArtifactContent } from '@/hooks/useArtifactContent';
import { API_URL } from '@/utils/api-client';
import { artifactObjectId } from '../workbench/real-surface-adapters';
import { workspaceV3Copy } from './workspace-v3.shell-copy';

function workCardLabel(artifact: ThreadArtifactDTO, imageLabel: string): string {
  // The content-block producer supplies this generic name for untitled images.
  const untitled =
    !artifact.name.trim() || (artifact.publicationItem?.kind === 'content-block' && artifact.name === '图片');
  return artifact.type === 'image' && untitled ? imageLabel : artifact.name;
}

function PaperPreview({ artifact }: { artifact: ThreadArtifactDTO }) {
  // Relative ref needs the original saved-location owner. A Home card has no execution-root proof.
  const body = useArtifactContent(artifact, null, !!artifact.url);
  const t = useShellCopy(workspaceV3Copy);
  return (
    <span className="home-work-paper text-xs">
      {body.content?.split('\n').slice(0, 6).join('\n') ||
        (body.loading ? t.worksLoading : body.error ? t.worksUnavailable : artifact.name)}
    </span>
  );
}
export function WorkCard({
  artifact,
  summary,
  metadata,
  onSelect,
  current,
}: {
  artifact: ThreadArtifactDTO;
  summary: boolean;
  metadata: string;
  worktreeId: string | null;
  onSelect: (card: HTMLButtonElement) => void;
  current?: boolean;
}) {
  const t = useShellCopy(workspaceV3Copy);
  const url = artifact.url ? resolveAssetUrl(artifact.url, API_URL) : null;
  const label = workCardLabel(artifact, t.image);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  const compact = summary || (artifact.type === 'image' && (!url || failedPreview === url));
  const download = async () => {
    if (!url || downloading) return;
    setDownloading(true);
    setDownloadFailed(false);
    try {
      const response = await fetch(url, {
        credentials: isSiteAssetPath(artifact.url) ? 'include' : 'same-origin',
      });
      if (!response.ok) throw new Error('Artifact download unavailable');
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = artifact.name;
        anchor.click();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  };
  const kind =
    artifact.type === 'pr'
      ? 'PR'
      : artifact.name.includes('.')
        ? artifact.name.split('.').at(-1)?.toUpperCase()
        : artifact.type.toUpperCase();
  return (
    <div className="home-work-entry">
      <button
        type="button"
        data-testid="workspace-home-artifact-card"
        data-home-artifact-id={artifactObjectId(artifact)}
        aria-current={current || undefined}
        className={`home-work-card shell-focusable ${compact ? 'home-work-summary' : ''}`}
        onClick={(event) => onSelect(event.currentTarget)}
      >
        <WorkVisual
          artifact={artifact}
          label={label}
          summary={compact}
          onImageError={() => setFailedPreview(url ?? null)}
        />
        <span className="home-work-label text-compact">{label}</span>
        <small className="home-work-meta text-xs">{compact ? `${kind} · ${metadata}` : metadata}</small>
        {failedPreview === url && url && <output className="text-xs">{t.noPreview}</output>}
      </button>
      {url && (
        <details
          className="home-work-menu"
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
            aria-label={t.download}
            aria-disabled={downloading || undefined}
            onClick={(event) => {
              event.preventDefault();
              void download();
            }}
          >
            {t.download}
          </a>
          {downloadFailed && <output role="alert">{t.downloadFailed}</output>}
        </details>
      )}
    </div>
  );
}

function WorkKind({ artifact, summary }: { artifact: ThreadArtifactDTO; summary: boolean }) {
  const label = artifact.type === 'pr' ? artifact.ref : artifact.name.split('.').at(-1)?.toUpperCase();
  return (
    <span className="home-work-kind">
      <ShellGlyph name={artifact.type === 'pr' ? 'gitPr' : 'filePen'} className={summary ? 'h-4 w-4' : 'h-10 w-10'} />
      {!summary && <span className="text-sm">{label}</span>}
    </span>
  );
}
function WorkVisual({
  artifact,
  label,
  summary,
  onImageError,
}: {
  artifact: ThreadArtifactDTO;
  label: string;
  summary: boolean;
  onImageError: () => void;
}) {
  if (summary) return <WorkKind artifact={artifact} summary />;
  if (artifact.type === 'image' && artifact.url)
    return (
      // biome-ignore lint/performance/noImgElement: original publication URL; preserve authenticated asset semantics.
      <img src={resolveAssetUrl(artifact.url, API_URL)} alt={label} onError={onImageError} />
    );
  if (classifyArtifactView(artifact) === 'text' && /\.(md|markdown)$/i.test(artifact.name))
    return <PaperPreview artifact={artifact} />;
  return <WorkKind artifact={artifact} summary={false} />;
}
