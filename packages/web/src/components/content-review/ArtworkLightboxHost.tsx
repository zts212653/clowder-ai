'use client';

import { Lightbox } from '@/components/Lightbox';
import { ContentSurfaceResolutionProvider } from '@/components/workbench/ContentSurfaceResolution';
import { F307OwnerSurfaceRenderer } from '@/components/workbench/F307OwnerSurfaceRenderer';
import { WorkspaceChatWorkSurface } from '@/components/workbench/WorkspaceChatWorkScope';
import { ArtworkGalleryScope, useArtworkGallery } from './ArtworkGalleryScope';
import { FloatingArtworkPresentation, useArtworkLightboxScope } from './ArtworkLightboxScope';
import { ArtworkOpeningPreview } from './ArtworkOpeningPreview';
import styles from './artwork-lightbox.module.css';

export function ArtworkLightboxHost() {
  const scope = useArtworkLightboxScope();
  const work = scope?.work;
  if (!scope || !work) return null;
  return (
    <ArtworkGalleryScope gallery={work.gallery} reference={work.reference}>
      <ArtworkLightboxContents />
    </ArtworkGalleryScope>
  );
}
function ArtworkLightboxContents() {
  const scope = useArtworkLightboxScope();
  const gallery = useArtworkGallery();
  const work = scope?.work;
  if (!scope || !work) return null;
  return (
    <FloatingArtworkPresentation>
      <Lightbox
        url={work.url}
        alt={work.alt}
        caption={work.caption}
        mediaType={work.mediaType}
        gallery={gallery}
        annotationUnavailableReason={work.reason}
        onClose={scope.close}
        onOpenWorkspace={work.openWorkspace}
        workspaceBusy={work.pending}
        composerSlot={
          <div ref={scope.setComposerSlot} className={styles.composer} data-testid="artwork-lightbox-composer" />
        }
      >
        <ArtworkOpeningPreview key={scope.getGeneration()} work={work}>
          {work.surface ? (
            <div className={styles.owner} data-testid="artwork-lightbox-owner">
              <ContentSurfaceResolutionProvider resolve={scope.resolve}>
                <WorkspaceChatWorkSurface surfaceId={work.surface.id}>
                  <F307OwnerSurfaceRenderer
                    surface={work.surface}
                    hostThreadId={scope.threadId}
                    onOpenSurface={scope.resolve}
                    onRefreshSurface={scope.resolve}
                    onOpenArtifactWithReturn={({ artifact }) => scope.resolve(artifact)}
                    onRequestDetach={scope.close}
                    onReturnToFileOrigin={scope.close}
                  />
                </WorkspaceChatWorkSurface>
              </ContentSurfaceResolutionProvider>
            </div>
          ) : undefined}
        </ArtworkOpeningPreview>
      </Lightbox>
    </FloatingArtworkPresentation>
  );
}
