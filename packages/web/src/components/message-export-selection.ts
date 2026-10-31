import { apiFetch } from '@/utils/api-client';

export interface ExportMessageLike {
  id: string;
}

export interface ExportMessageSelection<T extends ExportMessageLike> {
  messages: T[];
  ready: boolean;
}

export function selectMessagesForExport<T extends ExportMessageLike>(
  messages: readonly T[],
  selectedMessageIds: readonly string[],
): ExportMessageSelection<T> {
  if (selectedMessageIds.length === 0) {
    return { messages: [...messages], ready: messages.length > 0 };
  }

  if (new Set(selectedMessageIds).size !== selectedMessageIds.length) {
    return { messages: [], ready: false };
  }

  const byId = new Map(messages.map((message) => [message.id, message]));
  const selected = selectedMessageIds.flatMap((messageId) => {
    const message = byId.get(messageId);
    return message ? [message] : [];
  });
  return {
    messages: selected,
    ready: selected.length === selectedMessageIds.length,
  };
}

export async function loadExportThreadTitle(
  threadId: string,
  fetcher: (path: string) => Promise<Response> = apiFetch,
): Promise<string | null> {
  const response = await fetcher(`/api/threads/${threadId}`);
  if (!response.ok) return null;
  const body = (await response.json()) as { title?: unknown };
  return typeof body.title === 'string' ? body.title : null;
}
