'use client';
import type { GlobalArtifactDTO, ThreadArtifactDTO } from '@cat-cafe/shared';
import { useWorkCardOpen } from '@/components/artifacts/useWorkCardOpen';
import { createArtifactSurface } from '@/components/workbench/real-surface-adapters';
import { inferFileKind } from '@/lib/file-kind';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import { useArtworkLightboxScope } from './ArtworkLightboxScope';
import { artworkLightboxSurface } from './artwork-lightbox-surface';
import { useChatArtworkEntry, workspaceArtworkEntry } from './useChatArtworkEntry';
import { messagePublicationSource } from './usePublishedContent';

export function useArtifactLightbox(hostThreadId: string) {
  const scope = useArtworkLightboxScope();
  const entry = useChatArtworkEntry();
  const workCard = useWorkCardOpen(undefined, '');
  const open = (
    artifact: ThreadArtifactDTO | GlobalArtifactDTO,
    origin: WorkspaceFileNavigationOrigin | undefined,
  ): boolean => {
    if (!scope || !entry.isV2) return false;
    if (artifact.work?.contentRef.startsWith('work:')) {
      void workCard.open('lightbox', false, {
        reference: artifact.work,
        title: artifact.name,
        navigationOrigin: origin,
      });
      return true;
    }
    const url = artifact.url;
    // Published rich-file PNGs retain the catalogue's file type; the existing owner still admits their bytes.
    const image = artifact.type === 'image' || (artifact.type === 'file' && inferFileKind(artifact.name) === 'image');
    if (!image && artifact.type !== 'video')
      return scope.open({
        url: url ?? '',
        title: artifact.name,
        alt: artifact.name,
        mediaType: 'image',
        ownerContentOnly: true,
        surface: createArtifactSurface({ threadId: hostThreadId, artifact, navigationOrigin: origin }),
        openWorkspace: async () => {
          if (useChatStore.getState().currentThreadId !== hostThreadId) return false;
          captureChatReadingBeforeLayoutChange();
          useChatStore.getState().openPublishedArtifact(hostThreadId, artifact, origin, 'work-mode');
          scope.close();
          return true;
        },
      });
    if (!url) return false;
    const sourceThreadId = 'threadId' in artifact ? artifact.threadId : hostThreadId;
    const source =
      workspaceArtworkEntry(url) ??
      (artifact.sourceMessageId && artifact.publicationItem
        ? messagePublicationSource(
            {
              threadId: sourceThreadId,
              messageId: artifact.sourceMessageId,
              messageRevision: String(artifact.createdAt),
            },
            artifact.publicationItem,
            url,
          )
        : null);
    void entry.open(source, artifact.name, 'lightbox').then((result) => {
      if (result.status === 'blocked') return;
      scope.open({
        url: url.startsWith('/') ? `${API_URL}${url}` : url,
        title: artifact.name,
        alt: artifact.name,
        mediaType: artifact.type === 'video' ? 'video' : 'image',
        surface:
          result.status === 'opened'
            ? {
                ...artworkLightboxSurface(result.target, artifact.name),
                ...(origin ? { navigationOrigin: origin } : {}),
              }
            : null,
        ...(result.status === 'preview' ? { reason: result.reason } : {}),
        openWorkspace: async () => {
          const admitted = await entry.open(source, artifact.name, 'lightbox');
          if (admitted.status === 'blocked' || !admitted.target) return false;
          const chat = useChatStore.getState();
          if (chat.currentThreadId !== hostThreadId) return false;
          const target = { ...admitted.target, ...(origin ? { navigationOrigin: origin } : {}) };
          captureChatReadingBeforeLayoutChange();
          return target.kind === 'file'
            ? chat.openWorkspacePath(hostThreadId, target, 'work-mode')
            : chat.openPublication(target, hostThreadId, 'work-mode');
        },
      });
    });
    return true;
  };
  return { open, error: entry.error ?? workCard.error };
}
