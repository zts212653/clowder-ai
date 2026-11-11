'use client';

import type { MediaContextAttachment } from '@cat-cafe/shared';
import { createContext, useContext } from 'react';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
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
  /** Non-media cards render their existing document owner directly inside the same floating shell. */
  ownerContentOnly?: boolean;
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
export function useArtworkLightboxScope() {
  return useContext(Context);
}

const Presentation = createContext(false);
export function useFloatingArtworkPresentation() {
  return useContext(Presentation);
}
