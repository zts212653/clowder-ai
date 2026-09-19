import type { CatId } from '@cat-cafe/shared';
import { projectMessageBundleReadableContentWithCoverage } from '../../context/MessageBundleSourceProjection.js';
import { messageFrom } from '../../stores/message-from.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { canViewMessage, isTimelinePublished } from '../../stores/visibility.js';
import type { CallerDispatchObservationPointer, ObservationLine } from './caller-dispatch-observation-model.js';

const MAX_BODY_CHARS = 1_200;

interface MessageReadResult {
  message: StoredMessage | null;
  failed: boolean;
}

function compactBody(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_BODY_CHARS) return compact;
  return `${compact.slice(0, MAX_BODY_CHARS - 1)}…`;
}

function sourceOwnsPointer(source: StoredMessage, pointer: CallerDispatchObservationPointer): boolean {
  const from = messageFrom(source);
  return (
    source.id === pointer.sourceMessageId &&
    source.userId === pointer.ownerId &&
    source.threadId === pointer.threadId &&
    !source.deletedAt &&
    !source._tombstone &&
    isTimelinePublished(source) &&
    from.kind === 'agent' &&
    from.catId === pointer.callerCatId
  );
}

function canceledSourceOwnsWithdrawnPointer(source: StoredMessage, pointer: CallerDispatchObservationPointer): boolean {
  const from = messageFrom(source);
  return (
    pointer.selectionChange === 'removed' &&
    source.deliveryStatus === 'canceled' &&
    source.id === pointer.sourceMessageId &&
    source.userId === pointer.ownerId &&
    source.threadId === pointer.threadId &&
    !source.deletedAt &&
    !source._tombstone &&
    from.kind === 'agent' &&
    from.catId === pointer.callerCatId
  );
}

function isReadableObservationResponse(response: StoredMessage, pointer: CallerDispatchObservationPointer): boolean {
  return (
    response.threadId === pointer.threadId &&
    !response.deletedAt &&
    !response._tombstone &&
    response.origin !== 'briefing' &&
    isTimelinePublished(response) &&
    canViewMessage(response, { type: 'cat', catId: pointer.callerCatId as CatId })
  );
}

function unknownLine(pointer: CallerDispatchObservationPointer, reason: string): ObservationLine {
  return {
    line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: unknown（${reason}，保留待观察）`,
    terminal: false,
    fingerprint: `unknown:${reason}`,
  };
}

function unadmittedObservationLine(pointer: CallerDispatchObservationPointer): ObservationLine {
  if (pointer.selectionChange === 'removed') {
    const withdrawalReason =
      pointer.selectionChangedBy === 'steer'
        ? 'withdrawn by committed Steer'
        : pointer.selectionChangedBy === 'queue_withdrawal'
          ? 'withdrawn by committed Queue cancellation'
          : 'withdrawn by committed Queue mutation';
    return {
      line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: not_delivered(${withdrawalReason})`,
      terminal: true,
      fingerprint: `selection:removed:${pointer.selectionChangedBy}:${pointer.revision}`,
    };
  }
  return {
    line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: pending; selectedBy=${pointer.firstAddedBy}`,
    terminal: false,
    fingerprint: `selection:added:${pointer.selectionChangedBy}:${pointer.revision}`,
  };
}

async function readMessage(
  messageStore: Pick<IMessageStore, 'getById'>,
  messageId: string,
): Promise<MessageReadResult> {
  try {
    return { message: await messageStore.getById(messageId), failed: false };
  } catch {
    return { message: null, failed: true };
  }
}

function terminalObservationLine(
  response: StoredMessage,
  pointer: CallerDispatchObservationPointer,
): ObservationLine | null {
  const readable = projectMessageBundleReadableContentWithCoverage(response);
  if (!readable.fullyRepresented) return unknownLine(pointer, 'terminal payload 无法完整投影');
  const body = compactBody(readable.content) || '(empty)';
  if (
    response.lifecycle?.kind === 'response' &&
    response.userId === pointer.ownerId &&
    response.lifecycle.targetId === pointer.targetId &&
    response.lifecycle.inputMessageIds.includes(pointer.sourceMessageId)
  ) {
    if (response.lifecycle.status === 'processing') {
      return unknownLine(pointer, 'settled ref 指向 processing response');
    }
    return {
      line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: ${response.lifecycle.status}; response=${response.id}; body=${body}`,
      terminal: true,
      fingerprint: `response:${response.id}:${response.lifecycle.status}`,
    };
  }
  if (
    response.lifecycle?.kind !== 'delivery_failure' ||
    response.lifecycle.inputMessageId !== pointer.sourceMessageId ||
    !response.lifecycle.requestedTargets.includes(pointer.targetId)
  ) {
    return null;
  }
  return {
    line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: delivery_failure(${response.lifecycle.reason}); response=${response.id}; body=${body}`,
    terminal: true,
    fingerprint: `delivery_failure:${response.id}:${response.lifecycle.reason}`,
  };
}

export async function readCallerDispatchObservationLine(
  messageStore: Pick<IMessageStore, 'getById'>,
  pointer: CallerDispatchObservationPointer,
): Promise<ObservationLine> {
  const sourceRead = await readMessage(messageStore, pointer.sourceMessageId);
  if (sourceRead.failed) return unknownLine(pointer, 'History 读取失败');
  const source = sourceRead.message;
  if (!source) return unknownLine(pointer, 'source/scope 不可验证');
  if (!sourceOwnsPointer(source, pointer) && !canceledSourceOwnsWithdrawnPointer(source, pointer)) {
    return unknownLine(pointer, 'source/scope 不可验证');
  }
  if (source.lifecycle?.kind !== 'input' && source.lifecycle?.kind !== 'response') {
    return unknownLine(pointer, 'source lifecycle 不匹配');
  }
  const refs = (source.lifecycle.dispatchRefs ?? []).filter((ref) => ref.targetId === pointer.targetId);
  if (refs.length === 0) return unadmittedObservationLine(pointer);
  if (refs.length !== 1) return unknownLine(pointer, 'exact dispatchRef 不唯一');
  const ref = refs[0];
  if (!ref) return unknownLine(pointer, 'exact dispatchRef 缺失');
  if (ref.phase === 'dispatched') {
    return {
      line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: executing`,
      terminal: false,
      fingerprint: `dispatch:${ref.phase}:${ref.statusMessageId}`,
    };
  }

  const responseRead = await readMessage(messageStore, ref.statusMessageId);
  if (responseRead.failed) return unknownLine(pointer, 'terminal response 读取失败');
  const response = responseRead.message;
  if (!response || !isReadableObservationResponse(response, pointer)) {
    return unknownLine(pointer, 'terminal response 不可验证');
  }
  return terminalObservationLine(response, pointer) ?? unknownLine(pointer, 'response lifecycle 不匹配');
}
