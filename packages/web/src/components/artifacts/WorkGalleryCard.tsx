'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { artifactObjectId } from '@/components/workbench/real-surface-adapters';
import { ArtifactDownloadMenu } from './ArtifactDownloadMenu';
import type { WorkCardDescription } from './useWorkCardDescription';
import { WorkPreview } from './WorkPreview';
import { worksPanelCopy } from './works-panel.shell-copy';
import './work-gallery.css';
/** One card for Works, recent works and chat; each host retains its original owner. */
export function WorkGalleryCard({
  artifact,
  metadata,
  subtitle,
  footer,
  onSelect,
  onOpenSource,
  sourceLabel,
  onLatest,
  busy,
  description,
  copyName,
  previewPending,
  disabled,
  testId = 'workspace-home-artifact-card',
}: {
  artifact: ThreadArtifactDTO;
  metadata?: string;
  subtitle?: ReactNode;
  footer?: ReactNode;
  onSelect: (card: HTMLButtonElement) => void;
  onOpenSource?: () => void;
  sourceLabel?: string;
  onLatest?: () => void;
  busy?: boolean;
  description?: WorkCardDescription | null;
  copyName?: string;
  previewPending?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  const t = useShellCopy(worksPanelCopy);
  return (
    <article className="work-gallery-card cafe-presentation">
      <button
        type="button"
        className="work-gallery-open shell-focusable"
        data-testid={testId}
        data-home-artifact-id={artifactObjectId(artifact)}
        disabled={busy || disabled}
        aria-busy={busy || undefined}
        onClick={(event) => onSelect(event.currentTarget)}
      >
        <span className="work-gallery-visual">
          <WorkPreview artifact={artifact} description={description} pending={previewPending} />
        </span>
        <span className="work-gallery-title" title={artifact.name}>
          {artifact.name}
        </span>
        {subtitle && (
          <span className="work-gallery-subtitle" title={typeof subtitle === 'string' ? subtitle : undefined}>
            {subtitle}
          </span>
        )}
      </button>
      {onLatest && artifact.work && artifact.work.currentOwnerRevision > artifact.work.ownerRevision && (
        <button type="button" className="work-gallery-latest shell-focusable" disabled={busy} onClick={onLatest}>
          {t.newerVersion(artifact.work.currentOwnerRevision)}
        </button>
      )}
      <div className="work-gallery-footer">
        {footer ?? <small title={metadata}>{metadata}</small>}
        {onOpenSource && (
          <button
            type="button"
            className="work-gallery-source shell-focusable"
            aria-label={sourceLabel}
            title={sourceLabel}
            onClick={onOpenSource}
          >
            ↗
          </button>
        )}
      </div>
      <ArtifactDownloadMenu artifact={artifact} copyName={copyName} />
    </article>
  );
}
