import type { ContentModificationDetailView, ContentModificationRequest } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { checked, json, ModificationHttpError } from './modification-http';

export async function acceptContentResult(
  input: {
    requestId: string;
    candidateRef: string;
    acceptOperationId: string;
    source: Pick<
      Extract<ContentModificationRequest['source'], { kind: 'workspace' }>,
      'locator' | 'expectedSourceRevision'
    >;
  },
  refresh: (id: string) => Promise<ContentModificationDetailView>,
): Promise<AppliedAcceptance | null> {
  // The applied receipt's writtenRevision is what the person accepted — not whatever the file holds later.
  const applied = (view: ContentModificationDetailView): AppliedAcceptance | null => {
    const receipt = view.acceptances.find(
      (item) => item.acceptance.acceptOperationId === input.acceptOperationId && item.receipt?.state === 'applied',
    )?.receipt;
    return receipt ? { writtenRevision: receipt.writtenRevision } : null;
  };
  // A lost response is read back first. This read cannot repeat a file write or acquire a browser token.
  const before = await refresh(input.requestId);
  const already = applied(before);
  if (already) return already;
  const prior = before.acceptances.find((item) => item.acceptance.acceptOperationId === input.acceptOperationId);
  const baseRevision = prior?.acceptance.baseRevision ?? input.source.expectedSourceRevision;
  const send = async () => {
    const session = await checked<{ token: string }>(
      await apiFetch('/api/workspace/edit-session', json({ worktreeId: input.source.locator.worktreeId })),
    );
    return checked(
      await apiFetch(
        `/api/content-modifications/${encodeURIComponent(input.requestId)}/accept`,
        json({
          requestId: input.requestId,
          candidateRef: input.candidateRef,
          acceptOperationId: input.acceptOperationId,
          locator: input.source.locator,
          baseRevision,
          editSessionToken: session.token,
        }),
      ),
    );
  };
  try {
    await send();
  } catch (error) {
    if (!(error instanceof ModificationHttpError) || error.code !== 'edit_token_invalid') throw error;
    const retried = applied(await refresh(input.requestId));
    if (retried) return retried;
    await send();
  }
  return applied(await refresh(input.requestId));
}

export interface AppliedAcceptance {
  /** Revision this write produced; absent on receipts that did not record it. */
  readonly writtenRevision?: string;
}
