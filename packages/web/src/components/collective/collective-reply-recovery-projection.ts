import { apiFetch } from '@/utils/api-client';
import type { ParticipationView } from './use-collective-participation';

/** Fill only the Host-private recovery fact that the plugin view cannot own. */
export async function projectReplyRecovery(view: ParticipationView, signal?: AbortSignal): Promise<ParticipationView> {
  const recentEventIds = new Set(view.requests.slice(-20).map((request) => request.event.eventId));
  const taskSources = new Set(view.tasks.flatMap((task) => task.sourceRefs));
  const requests = await Promise.all(
    view.requests.map(async (request) => {
      const recipient = request.event.recipient;
      if (
        !recentEventIds.has(request.event.eventId) ||
        request.response ||
        request.failure ||
        request.delivery !== 'routed' ||
        request.execution !== undefined ||
        !request.messageId ||
        !request.privateThread ||
        recipient?.kind !== 'agent' ||
        taskSources.has(`message:${request.messageId}`)
      )
        return request;
      const path = `/api/threads/${encodeURIComponent(request.privateThread.id)}/messages/${encodeURIComponent(request.messageId)}/collective-reply-recovery/${encodeURIComponent(recipient.agentId)}`;
      try {
        const response = await apiFetch(path, { signal }, { afterCurrentGet: true });
        if (!response.ok) return request;
        const result = (await response.json()) as {
          status?: string;
          sourceMessageId?: string;
          responseMessageId?: string;
        };
        return result.status === 'recoverable' &&
          result.sourceMessageId === request.messageId &&
          typeof result.responseMessageId === 'string'
          ? { ...request, recovery: { status: 'recoverable' as const } }
          : request;
      } catch {
        return request;
      }
    }),
  );
  return { ...view, requests };
}
