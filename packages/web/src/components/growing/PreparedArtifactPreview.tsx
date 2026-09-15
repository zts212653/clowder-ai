'use client';

import type { EntrustedWorkOwnerReadV1, GlobalArtifactDTO } from '@cat-cafe/shared';
import type { ReactNode } from 'react';

export type PreparedArtifactCoordinate = NonNullable<EntrustedWorkOwnerReadV1['preparedArtifact']>;

export function PreparedArtifactPreview({
  coordinate,
  artifact,
  loading = false,
  onOpen,
  reviewAction,
}: {
  coordinate: PreparedArtifactCoordinate;
  artifact?: GlobalArtifactDTO;
  loading?: boolean;
  onOpen?: () => void;
  reviewAction?: ReactNode;
}) {
  return (
    <section
      className="rounded-xl border border-cafe-subtle bg-cafe-surface-sunken p-3"
      data-testid="prepared-artifact-preview"
      data-artifact-ref={coordinate.artifactRef}
      data-preview-ref={coordinate.previewRef}
      data-completeness-ref={coordinate.completenessRef}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-micro font-bold uppercase tracking-[0.14em] text-cafe-accent">准备好的 Artifact</p>
          <p className="mt-1 break-words text-sm font-semibold text-cafe-black">
            {artifact?.name ?? coordinate.artifactRef}
          </p>
          <p className="mt-1 text-micro text-cafe-muted">
            Artifact r{coordinate.artifactRevision} · 已可查看
            {artifact?.threadTitle ? ` · ${artifact.threadTitle}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {reviewAction}
          <button
            type="button"
            data-testid="needs-me-open-artifact"
            data-open-ref={coordinate.openInWorkspaceRef}
            disabled={loading}
            aria-busy={loading}
            className="shrink-0 rounded-lg bg-cafe-accent px-3 py-2 text-xs font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:cursor-wait disabled:opacity-60"
            onClick={onOpen}
          >
            {loading ? '正在加载产物…' : '在 Workspace 打开'}
          </button>
        </div>
      </div>
      {artifact?.type === 'image' && artifact.url ? (
        // biome-ignore lint/performance/noImgElement: F232 artifact URLs are runtime-owned and not Next image assets.
        <img
          src={artifact.url}
          alt={artifact.name}
          className="mt-3 max-h-44 w-full rounded-lg border border-cafe-subtle object-contain"
        />
      ) : null}
    </section>
  );
}
