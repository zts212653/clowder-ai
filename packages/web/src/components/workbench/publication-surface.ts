import { type MessageMediaPublicationSource, messageMediaPublicationSourceSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

const coordinate = z
  .object({
    contentRef: z.string().regex(/^prepared-media:[a-f0-9]{64}$/),
    ownerRevision: z.number().int().positive().safe(),
  })
  .strict();
export type PublicationTarget = z.infer<typeof coordinate>;

export function createPublicationSurface(
  input: PublicationTarget & {
    title: string;
    navigationOrigin?: WorkspaceFileNavigationOrigin;
    messagePublicationSource?: MessageMediaPublicationSource;
  },
): WorkspaceSurfaceDescriptor {
  const target = coordinate.parse({ contentRef: input.contentRef, ownerRevision: input.ownerRevision });
  return {
    id: `publication:${target.contentRef}`,
    type: 'artifact',
    renderer: 'artifact-view',
    title: input.title || '作品',
    context: `作品 · 版本 ${target.ownerRevision}`,
    objectRef: { kind: 'artifact', id: target.contentRef },
    ownerStateRef: { owner: 'f138-publication', key: JSON.stringify(target) },
    resultTargetRef: { owner: 'f138-publication', key: target.contentRef },
    ...(input.navigationOrigin ? { navigationOrigin: input.navigationOrigin } : {}),
    ...(input.messagePublicationSource
      ? { messagePublicationSource: messageMediaPublicationSourceSchema.parse(input.messagePublicationSource) }
      : {}),
    capabilities: { split: true, sidecar: true, pin: true, closePolicy: 'detach-host', restorePolicy: 'descriptor' },
  };
}
export function resolvePublicationTarget(surface: WorkspaceSurfaceDescriptor): PublicationTarget | null {
  if (
    surface.type !== 'artifact' ||
    surface.renderer !== 'artifact-view' ||
    surface.ownerStateRef.owner !== 'f138-publication' ||
    surface.objectRef.kind !== 'artifact'
  )
    return null;
  try {
    const target = coordinate.parse(JSON.parse(surface.ownerStateRef.key));
    if (
      surface.id !== `publication:${target.contentRef}` ||
      surface.objectRef.id !== target.contentRef ||
      surface.resultTargetRef?.owner !== 'f138-publication' ||
      surface.resultTargetRef.key !== target.contentRef
    )
      return null;
    return target;
  } catch {
    return null;
  }
}
