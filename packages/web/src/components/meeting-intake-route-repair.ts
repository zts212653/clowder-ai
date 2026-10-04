import type { Thread } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { meetingErrorMessage } from './meeting-intake-utils';
import { selectedMeetingDestinationId } from './meeting-thread-destination';

interface BindAndRetryInput {
  readonly threadId: string;
  readonly catId: string;
  readonly proposalId: string;
  readonly revision: number;
  /**
   * Asked after the destination's cat is saved and before delivery is retried. `false` stops here: the cat stays saved,
   * nothing is retried. Absent means no one is asking (the Approval Hub), and the retry always goes out.
   */
  readonly mayRetry?: () => boolean;
}

export type BindAndRetryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly message: string }
  /** The cat was saved and the retry was deliberately not sent. No response was seen, so there is no status. */
  | { readonly ok: false; readonly stopped: true; readonly message: string };

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
  mayRetry,
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

  if (mayRetry && !mayRetry()) {
    return { ok: false, stopped: true, message: '负责猫猫已经保存，但这条事项暂时不能写入，没有重新投递。' };
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
