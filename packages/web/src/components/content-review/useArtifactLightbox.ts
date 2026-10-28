'use client';
import type { GlobalArtifactDTO, ThreadArtifactDTO } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { artifactObjectId } from '../workbench/real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from '../workbench/workbench-contract';
import { type ContentOpenSource, contentOpenFacts } from './content-open-source';
import { useContentOpen } from './useContentOpen';

/** Entry supplies its source and attachment control; opening/type decisions have one implementation. */
export function useArtifactLightbox<Origin extends WorkspaceFileNavigationOrigin = WorkspaceFileNavigationOrigin>(
  hostThreadId: string,
  onOpenDocument?: (
    artifact: ThreadArtifactDTO | GlobalArtifactDTO,
    origin: Origin,
    surface: WorkspaceSurfaceDescriptor,
  ) => void,
  catalogue?: { items: readonly (ThreadArtifactDTO | GlobalArtifactDTO)[]; complete: boolean },
) {
  const opening = useContentOpen();
  const selected = useRef<string>();
  const invalidate = useRef(opening.invalidate);
  invalidate.current = opening.invalidate;
  useEffect(() => {
    if (!catalogue?.complete || !selected.current) return;
    if (!catalogue.items.some((item) => artifactObjectId(item) === selected.current)) {
      selected.current = undefined;
      invalidate.current('无法打开这件作品：原来源已不在当前目录中。');
    }
  }, [catalogue?.items, catalogue?.complete]);
  return {
    ...opening,
    open: (
      artifact: ThreadArtifactDTO | GlobalArtifactDTO,
      origin: Origin | undefined,
      catalogue: readonly (ThreadArtifactDTO | GlobalArtifactDTO)[] = [],
    ) => {
      selected.current = artifactObjectId(artifact);
      const sources: ContentOpenSource[] = catalogue
        .map((item) => ({
          kind: 'artifact' as const,
          threadId: 'threadId' in item ? item.threadId : hostThreadId,
          artifact: item,
          origin,
        }))
        .filter((source) => contentOpenFacts(source).floating);
      const index = sources.findIndex((source) => source.kind === 'artifact' && source.artifact === artifact);
      void opening.openContent({
        gallery: index >= 0 ? { items: sources, index } : undefined,
        kind: 'artifact',
        threadId: 'threadId' in artifact ? artifact.threadId : hostThreadId,
        artifact,
        origin,
        attach: onOpenDocument && origin ? (surface) => onOpenDocument(artifact, origin, surface) : undefined,
      });
      return true;
    },
  };
}
