'use client';

import type { MediaContextAttachment } from '@cat-cafe/shared';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { inheritContentSurfaceOrigin } from '@/components/workbench/resolve-content-surface';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { ArtworkMediaViewportProvider } from './ArtworkMediaViewport';
import type { ArtworkGallery } from './artwork-gallery';

export type FloatingArtwork = {
  url: string;
  title: string;
  alt: string;
  mediaType: 'image' | 'video';
  caption?: string;
  reason?: string;
  surface: WorkspaceSurfaceDescriptor | null;
  pending?: boolean;
  openWorkspace?: () => Promise<boolean>;
  gallery?: ArtworkGallery;
  reference?: {
    attachment: MediaContextAttachment;
    selectionId?: string;
    origin?: { kind: 'composer'; threadId: string } | { kind: 'message'; threadId: string; messageId: string };
  };
};
type Scope = {
  threadId: string;
  work: FloatingArtwork | null;
  workModeWork: FloatingArtwork | null;
  open: (work: FloatingArtwork, expectedGeneration?: number) => boolean;
  update: (work: FloatingArtwork, expectedGeneration: number) => boolean;
  enterWorkMode: (work: FloatingArtwork, expectedGeneration?: number) => boolean;
  clearWorkMode: () => void;
  getGeneration: () => number;
  close: () => void;
  resolve: (surface: WorkspaceSurfaceDescriptor) => void;
  resolveWorkMode: (surface: WorkspaceSurfaceDescriptor, sourceSurfaceId: string) => void;
  composerSlot: HTMLDivElement | null;
  setComposerSlot: (element: HTMLDivElement | null) => void;
  toolsSlot: HTMLDivElement | null;
  setToolsSlot: (element: HTMLDivElement | null) => void;
};
const Context = createContext<Scope | null>(null);
// These are presentation slots, never a second conversation, owner or draft store.
export function ArtworkLightboxProvider({ threadId, children }: { threadId: string; children: ReactNode }) {
  const [presentation, setPresentation] = useState<{
    threadId: string;
    visit: number;
    work: FloatingArtwork | null;
    workModeWork: FloatingArtwork | null;
    generation: number;
  }>({
    threadId,
    visit: 0,
    work: null,
    workModeWork: null,
    generation: 0,
  });
  const { work, workModeWork, generation, visit } = presentation;
  // Reset this presentation before its children render the new thread. Keying
  // the provider instead remounts the entire Chat, its viewport and composer.
  if (presentation.threadId !== threadId) {
    setPresentation({ threadId, visit: visit + 1, work: null, workModeWork: null, generation: generation + 1 });
  }
  const [composerSlot, setComposerSlot] = useState<HTMLDivElement | null>(null);
  const [toolsSlot, setToolsSlot] = useState<HTMLDivElement | null>(null);
  const commands = useRef({ threadId, generation, visit });
  if (commands.current.threadId !== threadId)
    commands.current = { threadId, generation: generation + 1, visit: visit + 1 };
  const getGeneration = useCallback(() => commands.current.generation, []);
  const present = useCallback(
    (next: FloatingArtwork, inWorkspace: boolean, expectedGeneration?: number) => {
      if (
        commands.current.visit !== visit ||
        (expectedGeneration !== undefined && commands.current.generation !== expectedGeneration)
      )
        return false;
      const nextGeneration = ++commands.current.generation;
      setPresentation((current) =>
        current.visit !== visit
          ? current
          : {
              ...current,
              generation: nextGeneration,
              ...(inWorkspace ? { work: null, workModeWork: next } : { work: next }),
            },
      );
      return true;
    },
    [visit],
  );
  const open = useCallback(
    (next: FloatingArtwork, expectedGeneration?: number) => present(next, false, expectedGeneration),
    [present],
  );
  // Filling in an already opened preview is not another navigation. Closing,
  // selecting another work or leaving this thread invalidates its exact ticket.
  const update = useCallback(
    (next: FloatingArtwork, expectedGeneration: number) => {
      if (commands.current.visit !== visit || commands.current.generation !== expectedGeneration) return false;
      setPresentation((current) =>
        current.visit !== visit || current.generation !== expectedGeneration || !current.work
          ? current
          : { ...current, work: next },
      );
      return true;
    },
    [visit],
  );
  const enterWorkMode = useCallback(
    (next: FloatingArtwork, expectedGeneration?: number) => present(next, true, expectedGeneration),
    [present],
  );
  const close = useCallback(() => {
    if (commands.current.visit !== visit) return;
    const nextGeneration = ++commands.current.generation;
    setPresentation((current) =>
      current.visit !== visit ? current : { ...current, work: null, generation: nextGeneration },
    );
  }, [visit]);
  const clearWorkMode = useCallback(
    () =>
      setPresentation((current) =>
        current.visit !== visit || !current.workModeWork ? current : { ...current, workModeWork: null },
      ),
    [visit],
  );
  const sourceSurfaceId = work?.surface?.id;
  const resolve = useCallback(
    (surface: WorkspaceSurfaceDescriptor) =>
      setPresentation((current) =>
        current.visit !== visit ||
        current.generation !== generation ||
        !current.work?.surface ||
        current.work.surface.id !== sourceSurfaceId
          ? current
          : {
              ...current,
              work: { ...current.work, surface: inheritContentSurfaceOrigin(current.work.surface, surface) },
            },
      ),
    [generation, sourceSurfaceId, visit],
  );
  const workModeSurfaceId = workModeWork?.surface?.id;
  const resolveWorkMode = useCallback(
    (surface: WorkspaceSurfaceDescriptor, resolvedSourceId: string) =>
      setPresentation((current) =>
        current.visit !== visit ||
        current.generation !== generation ||
        resolvedSourceId !== workModeSurfaceId ||
        !current.workModeWork?.surface ||
        current.workModeWork.surface.id !== resolvedSourceId
          ? current
          : {
              ...current,
              workModeWork: {
                ...current.workModeWork,
                surface: inheritContentSurfaceOrigin(current.workModeWork.surface, surface),
              },
            },
      ),
    [generation, workModeSurfaceId, visit],
  );
  const value = useMemo(
    () => ({
      threadId,
      work,
      workModeWork,
      open,
      update,
      enterWorkMode,
      clearWorkMode,
      getGeneration,
      close,
      resolve,
      resolveWorkMode,
      composerSlot,
      setComposerSlot,
      toolsSlot,
      setToolsSlot,
    }),
    [
      threadId,
      work,
      workModeWork,
      open,
      update,
      enterWorkMode,
      clearWorkMode,
      getGeneration,
      close,
      resolve,
      resolveWorkMode,
      composerSlot,
      toolsSlot,
    ],
  );
  return (
    <ArtworkMediaViewportProvider scopeKey={visit}>
      <Context.Provider value={value}>{children}</Context.Provider>
    </ArtworkMediaViewportProvider>
  );
}
export function useArtworkLightboxScope() {
  return useContext(Context);
}

const Presentation = createContext(false);
export function FloatingArtworkPresentation({ children }: { children: ReactNode }) {
  return <Presentation.Provider value>{children}</Presentation.Provider>;
}
export function useFloatingArtworkPresentation() {
  return useContext(Presentation);
}
