import {
  CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH,
  type MessageNavigationAdmission,
  type MessageSearchResult,
} from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { createQuoteContextAttachment } from '../chat-context-reference';

export type ReadSourceMessage = NonNullable<MessageNavigationAdmission['message']>;
export type ReadSourceContext = { message: ReadSourceMessage; following: ReadSourceMessage[]; updated: boolean };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function sourceMessage(value: unknown): value is ReadSourceMessage {
  return (
    object(value) &&
    typeof value.threadId === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.content === 'string' &&
    value.content.length <= CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH &&
    typeof value.speaker === 'string' &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    typeof value.contentRevision === 'string' &&
    !!value.contentRevision &&
    typeof value.truncated === 'boolean'
  );
}

/** Same source admission endpoint as navigation. Each expansion/quote is a new read, never a search. */
export async function readMessageSource(
  result: MessageSearchResult,
  count: number,
  signal: AbortSignal,
): Promise<ReadSourceContext> {
  const params = new URLSearchParams({
    threadId: result.threadId,
    messageId: result.messageId,
    contentRevision: result.contentRevision,
    contextCount: String(count),
  });
  const response = await apiFetch(`/api/evidence/navigation-source?${params}`, { signal });
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? '这条来源目前不可访问。'
        : '这条来源暂不可读取，请重试或去原处查看。',
    );
  const body: unknown = await response.json();
  signal.throwIfAborted();
  if (
    !object(body) ||
    body.status !== 'available' ||
    typeof body.updated !== 'boolean' ||
    !object(body.target) ||
    body.target.threadId !== result.threadId ||
    body.target.messageId !== result.messageId ||
    !sourceMessage(body.message) ||
    body.message.threadId !== result.threadId ||
    body.message.messageId !== result.messageId ||
    body.message.contentRevision !== body.target.contentRevision ||
    !Array.isArray(body.following) ||
    body.following.length > count ||
    !body.following.every(
      (item) => sourceMessage(item) && item.threadId === result.threadId && item.messageId !== result.messageId,
    )
  )
    throw new Error('来源信息不完整，请去原处查看。');
  return { message: body.message, following: body.following, updated: body.updated };
}

export const decisionLabel = (status: NonNullable<MessageSearchResult['decisionSources']>[number]['status']) =>
  ({ decided: '已定', 'not-adopted': '提议 · 没采用', superseded: '后来改了' })[status];

export function sourceTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

export function sourceSpeakerLabel(
  message: { speaker: string; speakerLabel?: string },
  resolve: (speaker: string) => string,
) {
  if (message.speaker === 'system') return '系统通知';
  if (message.speaker === 'connector') return message.speakerLabel || '外部来源';
  return resolve(message.speaker);
}

export function messageSourceQuote(
  result: MessageSearchResult,
  message: ReadSourceMessage,
  resolve: (speaker: string) => string,
) {
  if (message.truncated || message.content.length > CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH)
    throw new Error('原文较长，请去原处选择需要引用的段落。');
  if (!message.content.trim()) throw new Error('这条来源没有可引用的文字，请去原处查看。');
  const labels = [...new Set(result.decisionSources?.map((fact) => decisionLabel(fact.status)) ?? [])];
  const displayLabel = `${sourceSpeakerLabel(message, resolve).slice(0, 80)} · ${sourceTime(message.timestamp)}${labels.length ? ` · ${labels.join(' / ')}` : ''}`;
  return createQuoteContextAttachment(message.content, {
    kind: 'message',
    threadId: result.threadId,
    messageId: result.messageId,
    displayLabel,
    ...(!['user', 'system', 'connector'].includes(message.speaker) ? { senderCatId: message.speaker } : {}),
  });
}
