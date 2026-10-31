import { createMessagePublicationSurface } from '@/components/workbench/message-publication-surface';
import { createPublicationSurface } from '@/components/workbench/publication-surface';
import { createFilePreviewSurface } from '@/components/workbench/real-surface-adapters';
import type { ArtworkTarget } from './usePublishedContent';

export function artworkLightboxSurface(target: ArtworkTarget, title: string) {
  if (target.kind === 'file') return createFilePreviewSurface(target);
  if (target.kind === 'message-publication')
    return { ...createMessagePublicationSurface(target.source, title), navigationOrigin: target.navigationOrigin };
  return createPublicationSurface({ ...target, title });
}
