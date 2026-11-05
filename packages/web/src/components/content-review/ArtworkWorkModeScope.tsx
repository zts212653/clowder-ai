'use client';
import { createContext, type ReactNode, useContext } from 'react';
import { ContentSurfaceResolutionProvider } from '@/components/workbench/ContentSurfaceResolution';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { resolveMessagePublicationSource } from '@/components/workbench/message-publication-surface';
import { ArtworkGalleryScope } from './ArtworkGalleryScope';
import { useArtworkLightboxScope } from './ArtworkLightboxScope';

type WorkMode = { onReturn: () => void; fullWindowAction?: { active: boolean; onToggle: () => void } };
const Context = createContext<WorkMode | null>(null);
/** The Chat host keeps its return action; artwork only presents it in its one header. */
export function ArtworkWorkModeScope({
  onReturn,
  fullWindowAction,
  children,
}: {
  onReturn: (() => void) | null;
  fullWindowAction?: WorkMode['fullWindowAction'];
  children: ReactNode;
}) {
  const scope = useArtworkLightboxScope();
  const active = useF307ExperienceWorkbenchStore((state) =>
    state.layout.surfaces.find((item) => item.id === state.layout.activeSurfaceId),
  );
  const work = scope?.workModeWork;
  const original =
    work?.surface && (resolveMessagePublicationSource(work.surface) ?? work.surface.messagePublicationSource);
  const actual = active && (resolveMessagePublicationSource(active) ?? active.messagePublicationSource);
  const matches =
    !!work?.surface &&
    !!active &&
    (work.surface.id === active.id || (!!original && JSON.stringify(original) === JSON.stringify(actual)));
  const back = () => {
    scope?.clearWorkMode();
    scope?.close();
    onReturn?.();
  };
  return (
    <Context.Provider value={onReturn ? { onReturn: back, fullWindowAction } : null}>
      <ArtworkGalleryScope
        gallery={onReturn && matches ? work?.gallery : undefined}
        reference={onReturn && matches ? work?.reference : undefined}
      >
        <ContentSurfaceResolutionProvider
          resolve={(surface, sourceSurfaceId) => {
            if (onReturn) scope?.resolveWorkMode(surface, sourceSurfaceId);
            useF307ExperienceWorkbenchStore
              .getState()
              .dispatch({ type: 'resolve-content-surface', sourceSurfaceId, surface });
          }}
        >
          {children}
        </ContentSurfaceResolutionProvider>
      </ArtworkGalleryScope>
    </Context.Provider>
  );
}
export function useArtworkWorkMode() {
  return useContext(Context);
}
