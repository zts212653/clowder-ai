'use client';
import { projectFileContent, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { type ReactNode, useRef } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { artifactObjectId } from '@/components/workbench/real-surface-adapters';
import { FileActions } from '../content-review/FileActions';
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
  current,
  compact = false,
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
  current?: boolean;
  compact?: boolean;
  testId?: string;
}) {
  const t = useShellCopy(worksPanelCopy);
  const card = useRef<HTMLElement>(null);
  const facts = projectFileContent(artifact);
  const untitledImage =
    artifact.type === 'image' &&
    (!artifact.name.trim() || (artifact.publicationItem?.kind === 'content-block' && artifact.name === '图片'));
  const label = untitledImage ? t.untitledImage : artifact.name;
  return (
    <article ref={card} className="work-gallery-card cafe-presentation">
      <button
        type="button"
        className={`work-gallery-open shell-focusable${compact ? ' home-work-summary' : ''}`}
        data-testid={testId}
        data-home-artifact-id={artifactObjectId(artifact)}
        disabled={busy || disabled}
        aria-busy={busy || undefined}
        aria-current={current || undefined}
        onClick={(event) => onSelect(event.currentTarget)}
      >
        <span className="work-gallery-visual">
          <WorkPreview
            title={label}
            artifact={artifact}
            description={description}
            pending={previewPending}
            compact={compact}
          />
        </span>
        <span className="work-gallery-title home-work-label" title={label}>
          {label}
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
        {footer ?? (
          <small className="home-work-meta" title={metadata}>
            {metadata}
          </small>
        )}
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
      {artifact.url && (
        <div className="work-gallery-actions">
          <FileActions
            source={{ kind: 'url', url: artifact.url }}
            filename={copyName ?? artifact.name}
            mime={facts.mime}
            copyName
            contextRef={card}
            src={facts.kind === 'image' ? artifact.url : null}
            root={card}
          />
        </div>
      )}
    </article>
  );
}
