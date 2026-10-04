import {
  type MessageMediaPublicationSource,
  messageMediaItemKey,
  messageMediaPublicationSourceSchema,
} from '@cat-cafe/shared';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

function sourceKey(source: MessageMediaPublicationSource) {
  return JSON.stringify([source.threadId, source.messageId, source.messageRevision, messageMediaItemKey(source.item)]);
}
export function createMessagePublicationSurface(
  input: MessageMediaPublicationSource,
  title: string,
): WorkspaceSurfaceDescriptor {
  const source = messageMediaPublicationSourceSchema.parse(input);
  const key = sourceKey(source);
  return {
    id: `message-publication:${key}`,
    type: 'artifact',
    renderer: 'artifact-view',
    title,
    context: '正在核对原作品',
    objectRef: { kind: 'artifact', id: key },
    ownerStateRef: { owner: 'f138-message-source', key: JSON.stringify(source) },
    navigationOrigin: { kind: 'chat-file-link', threadId: source.threadId, messageId: source.messageId },
    capabilities: { split: true, sidecar: true, pin: true, closePolicy: 'detach-host', restorePolicy: 'descriptor' },
  };
}
export function resolveMessagePublicationSource(
  surface: WorkspaceSurfaceDescriptor,
): MessageMediaPublicationSource | null {
  if (
    surface.type !== 'artifact' ||
    surface.renderer !== 'artifact-view' ||
    surface.ownerStateRef.owner !== 'f138-message-source'
  )
    return null;
  try {
    const source = messageMediaPublicationSourceSchema.parse(JSON.parse(surface.ownerStateRef.key));
    const key = sourceKey(source);
    return surface.id === `message-publication:${key}` &&
      surface.objectRef.kind === 'artifact' &&
      surface.objectRef.id === key
      ? source
      : null;
  } catch {
    return null;
  }
}
