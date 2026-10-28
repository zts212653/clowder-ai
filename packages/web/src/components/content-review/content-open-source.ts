import {
  type GlobalArtifactDTO,
  type MessageMediaItemSelector,
  projectFileContent,
  type ThreadArtifactDTO,
  type WorkReference,
} from '@cat-cafe/shared';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import type { CollectiveDocumentHostTarget } from '../workbench/collective-document-surface';
import type { createFileSurface } from '../workbench/real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from '../workbench/workbench-contract';
import { fileSourceUrl } from './file-action-client';
import type { PublishedMessageCoordinate } from './usePublishedContent';

type Origin = { origin?: WorkspaceFileNavigationOrigin };
export type ContentOpenSource = Origin & { gallery?: { items: readonly ContentOpenSource[]; index: number } } & (
    | {
        kind: 'workspace';
        target: Parameters<typeof createFileSurface>[0];
        attach?: (surface: WorkspaceSurfaceDescriptor) => void;
      }
    | {
        kind: 'artifact';
        threadId: string;
        artifact: ThreadArtifactDTO | GlobalArtifactDTO;
        attach?: (surface: WorkspaceSurfaceDescriptor) => void;
      }
    | ({ kind: 'collective' } & CollectiveDocumentHostTarget)
    | { kind: 'work'; reference: WorkReference; title: string; current?: boolean; expectedSurfaceKey?: string }
    | {
        kind: 'message-file';
        url: string;
        name: string;
        mime?: string;
        item: MessageMediaItemSelector;
        coordinate: PublishedMessageCoordinate;
        sourceMessageIds?: readonly string[];
        current?: boolean;
        reference?: WorkReference | null;
        resolveRegistered?: () => Promise<ThreadArtifactDTO | null>;
      }
  );
/** Presentation follows content facts, never the entry component or its URL spelling. */
export function contentOpenFacts(source: Exclude<ContentOpenSource, { kind: 'work' }>) {
  return projectFileContent(
    source.kind === 'collective'
      ? { name: '共同作品.md', mime: 'text/markdown' }
      : source.kind === 'workspace'
        ? { name: source.target.path }
        : source.kind === 'artifact'
          ? source.artifact
          : source,
  );
}

/** Gallery entries are locator previews only; paging admits the selected source through openContent. */
export function contentSourcePreview(source: ContentOpenSource) {
  const name = source.kind === 'work' ? source.title : contentOpenFacts(source).name;
  const facts = source.kind === 'work' ? null : contentOpenFacts(source);
  const url =
    source.kind === 'work' || source.kind === 'collective'
      ? ''
      : source.kind === 'workspace'
        ? fileSourceUrl({ kind: 'workspace', ...source.target })
        : fileSourceUrl({ kind: 'url', url: source.kind === 'artifact' ? (source.artifact.url ?? '') : source.url });
  return {
    url: url ?? '',
    title: name,
    alt: name,
    mediaType: facts?.kind === 'video' ? ('video' as const) : ('image' as const),
  };
}
