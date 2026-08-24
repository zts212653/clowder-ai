import type { Thread } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { meetingErrorMessage } from './meeting-intake-utils';
import { selectedMeetingDestinationId } from './meeting-thread-destination';

interface BindAndRetryInput {
  readonly threadId: string;
  readonly catId: string;
  readonly proposalId: string;
  readonly revision: number;
}

export type BindAndRetryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly message: string };

async function readResponseBody(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

export function routeCatRepairThreadId(
  repairCode: string | undefined,
  destinationHandle: string,
  threads: readonly Thread[],
): string | null {
  if (repairCode !== 'route_unavailable') return null;
  const threadId = selectedMeetingDestinationId(destinationHandle);
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (!thread || thread.participants.length > 0 || thread.preferredCats?.length) return null;
  return thread.id;
}

export async function bindMeetingDestinationCatAndRetry({
  threadId,
  catId,
  proposalId,
  revision,
}: BindAndRetryInput): Promise<BindAndRetryResult> {
  const patchResponse = await apiFetch(`/api/threads/${threadId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferredCats: [catId] }),
  });
  const patchBody = await readResponseBody(patchResponse);
  if (!patchResponse.ok) {
    return {
      ok: false,
      status: patchResponse.status,
      message: `没能保存负责猫猫：${meetingErrorMessage(patchBody, patchResponse.status)}`,
    };
  }

  const retryResponse = await apiFetch(`/api/meeting-intakes/${proposalId}/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: revision }),
  });
  const retryBody = await readResponseBody(retryResponse);
  if (!retryResponse.ok) {
    return {
      ok: false,
      status: retryResponse.status,
      message: `负责猫猫已经保存，但重新投递失败：${meetingErrorMessage(retryBody, retryResponse.status)}`,
    };
  }
  return { ok: true };
}
