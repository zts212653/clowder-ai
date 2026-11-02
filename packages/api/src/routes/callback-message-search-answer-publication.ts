import type { CallbackPrincipal, MessageSearchAnswerAttachmentRequest } from '@cat-cafe/shared';
import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { MessageSearchAnswerPublicationService } from '../domains/memory/MessageSearchAnswerPublicationService.js';
import type { AnswerProducer } from '../domains/memory/MessageSearchAnswerPublicationStore.js';

export const callbackAnswerProducer = (principal: CallbackPrincipal): AnswerProducer => ({
  kind: principal.kind,
  id: principal.kind === 'invocation' ? principal.invocationId : principal.agentKeyId,
  catId: principal.catId,
});
export async function prepareCallbackSearchAnswer(
  service: MessageSearchAnswerPublicationService | undefined,
  request: MessageSearchAnswerAttachmentRequest | undefined,
  principal: CallbackPrincipal,
  threadId: string,
  clientMessageId: string | undefined,
  existingMessageId?: string,
) {
  if (!request) return { ok: true as const, block: null };
  if (!clientMessageId)
    return {
      ok: false as const,
      status: 400,
      error: 'searchAnswer requires clientMessageId for recoverable publication',
    };
  if (!service) return { ok: false as const, status: 503, error: 'Answer publication unavailable' };
  const block = await service.preparePost(
    request,
    principal.userId,
    callbackAnswerProducer(principal),
    threadId,
    existingMessageId,
  );
  return block
    ? { ok: true as const, block }
    : { ok: false as const, status: 409, error: 'Answer reference does not match this accepted message use' };
}
export async function publishCallbackSearchAnswer(
  service: MessageSearchAnswerPublicationService | undefined,
  request: MessageSearchAnswerAttachmentRequest | undefined,
  principal: CallbackPrincipal,
  message: StoredMessage,
): Promise<StoredMessage> {
  if (!request) return message;
  const published = await service?.publishPost(
    request,
    message.id,
    callbackAnswerProducer(principal),
    principal.userId,
  );
  if (!published)
    throw Object.assign(
      new Error(
        'Message is durable; answer binding is pending. Retry the same clientMessageId, without repeating search.',
      ),
      { statusCode: 503 },
    );
  return published;
}
