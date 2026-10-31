import type { WorkspaceContentAnnotation } from '@cat-cafe/shared';
import {
  deriveGrowingSourceMessageRevision,
  type StoredMessage,
} from '../../../cats/services/stores/ports/MessageStore.js';
import type { VideoProjectPrincipal } from '../../../video-studio/project/access.js';
import type { VideoProjectMessageAuthority } from './types.js';

export function isDeliveredProjectHuman(message: StoredMessage, ownerUserId: string): boolean {
  return (
    message.userId === ownerUserId &&
    message.catId === null &&
    !message.source &&
    !message.sourceParseFailure &&
    message.origin !== 'briefing' &&
    message.deletedAt === undefined &&
    !message._tombstone &&
    !message.recall &&
    (message.deliveryStatus === undefined || message.deliveryStatus === 'delivered')
  );
}

function inAudience(
  principal: VideoProjectPrincipal,
  visibility: 'public' | 'whisper',
  recipients: readonly string[],
): boolean {
  return principal.actor.kind === 'human' || visibility === 'public' || recipients.includes(principal.actor.actorId);
}

/** Frozen audience never widens; current thread permission and current source audience can only narrow it. */
export async function projectMessageAnnotationProjection(
  annotation: WorkspaceContentAnnotation,
  principal: VideoProjectPrincipal,
  authority?: VideoProjectMessageAuthority,
  permission: 'read' | 'write' = 'read',
): Promise<WorkspaceContentAnnotation | undefined> {
  const context = annotation.projectMessage;
  if (!context) return annotation;
  if (!authority || !inAudience(principal, context.source.visibility, context.source.whisperTo)) return;
  try {
    await authority.authorizeSource({
      principal,
      threadId: context.source.threadId,
      messageId: context.source.messageId,
      permission,
    });
    const current = await authority.messages.getById(context.source.messageId);
    const sourceState = !current
      ? 'unavailable'
      : !isDeliveredProjectHuman(current, principal.userId) ||
          current.threadId !== context.source.threadId ||
          deriveGrowingSourceMessageRevision(current) !== context.source.messageRevision
        ? 'changed'
        : 'current';
    if (
      principal.actor.kind === 'cat' &&
      (sourceState !== 'current' ||
        !current ||
        !inAudience(principal, current.visibility ?? 'public', current.whisperTo ?? []))
    )
      return;
    return { ...annotation, projectMessage: { ...context, sourceState } };
  } catch {
    return;
  }
}
