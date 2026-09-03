const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;

export interface PersonalChromeAssistantReturnCursor {
  readonly conversationId: string;
  readonly sourceMessageId: string;
  readonly assistantMessageId: string;
}

export interface PersonalChromeAssistantReturnCursorFields {
  readonly afterConversationId?: string;
  readonly afterSourceMessageId?: string;
  readonly afterAssistantMessageId?: string;
}

export function assistantReturnCursorFields(
  cursor?: PersonalChromeAssistantReturnCursor,
): PersonalChromeAssistantReturnCursorFields {
  return cursor
    ? {
        afterConversationId: cursor.conversationId,
        afterSourceMessageId: cursor.sourceMessageId,
        afterAssistantMessageId: cursor.assistantMessageId,
      }
    : {};
}

export function parseAssistantReturnCursorFields(
  record: Readonly<Record<string, unknown>>,
): PersonalChromeAssistantReturnCursorFields {
  const hasConversation = Object.hasOwn(record, 'afterConversationId');
  const hasSource = Object.hasOwn(record, 'afterSourceMessageId');
  const hasAssistant = Object.hasOwn(record, 'afterAssistantMessageId');
  if (hasConversation !== hasSource || hasSource !== hasAssistant) {
    throw new Error('assistant return list cursor must contain conversation, source, and assistant message IDs');
  }
  if (!hasConversation) return {};
  if (
    typeof record.afterConversationId !== 'string' ||
    record.afterConversationId.length > 200 ||
    !SAFE_TOKEN.test(record.afterConversationId) ||
    typeof record.afterSourceMessageId !== 'string' ||
    record.afterSourceMessageId.length > 512 ||
    !SAFE_TOKEN.test(record.afterSourceMessageId) ||
    typeof record.afterAssistantMessageId !== 'string' ||
    record.afterAssistantMessageId.length > 512 ||
    !SAFE_TOKEN.test(record.afterAssistantMessageId)
  ) {
    throw new Error('assistant return list cursor contains an invalid identity token');
  }
  return {
    afterConversationId: record.afterConversationId,
    afterSourceMessageId: record.afterSourceMessageId,
    afterAssistantMessageId: record.afterAssistantMessageId,
  };
}
