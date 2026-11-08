import {
  type MessageSearchAnswerView,
  type MessageSearchResponse,
  type MessageSearchResult,
  messageSearchAnswerRefSchema,
  messageSearchResponseSchema,
} from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';

/** The server verifies the real message/card binding; copied meta is never publication proof. */
export async function readAnswer(
  messageId: string,
  blockId: string,
  signal?: AbortSignal,
): Promise<MessageSearchAnswerView | null> {
  const response = await apiFetch(`/api/evidence/answer?${new URLSearchParams({ messageId, blockId })}`, { signal });
  if (!response.ok) return null;
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const parsed = messageSearchResponseSchema.safeParse(record.response);
  if (
    record.status !== 'available' ||
    !parsed.success ||
    !messageSearchAnswerRefSchema.safeParse(record.publicationRef).success
  )
    return null;
  return {
    status: 'available',
    response: parsed.data,
    publicationRef: String(record.publicationRef),
    changedSources: typeof record.changedSources === 'number' ? record.changedSources : 0,
    decisionUpdated: record.decisionUpdated === true,
  };
}

export async function readSelectedAnswerRow(
  response: MessageSearchResponse,
  result: MessageSearchResult,
  signal: AbortSignal,
): Promise<boolean> {
  const binding = response.meta.answerBinding;
  if (!binding) return false;
  const fresh = await readAnswer(binding.messageId, binding.blockId, signal);
  const row = fresh?.response?.results.find(
    (candidate) => candidate.threadId === result.threadId && candidate.messageId === result.messageId,
  );
  return !!row && JSON.stringify(row) === JSON.stringify(result);
}
