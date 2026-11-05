import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity, observeApiSessionOwner } from '@/utils/api-session-identity';
import { type ApprovalResultKey, approvalResultRead } from './approval-result-read';

/** Retains the original response body; each producer's existing identity/shape validator still owns its meaning. */
export async function readApprovalProducerBody(
  key: ApprovalResultKey,
  path: string,
  options: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<unknown> {
  const value = await approvalResultRead.read(
    key,
    'native',
    (signal) => fetchApprovalProducerBody(key, path, signal),
    options.fresh,
  );
  options.signal?.throwIfAborted();
  return value;
}

export async function fetchApprovalProducerBody(
  key: ApprovalResultKey,
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  const before = apiSessionIdentity.getSnapshot();
  if (before.ownerUserId && before.ownerUserId !== key.owner) throw new Error('Approval owner changed');
  const response = await apiFetch(path, { signal }, { afterCurrentGet: true });
  if (response.status === 401 || response.status === 403) {
    observeApiSessionOwner(null);
    throw new Error('Approval owner unavailable');
  }
  if (!response.ok) throw new Error('Approval source unavailable');
  const body: unknown = await response.json();
  const current = apiSessionIdentity.getSnapshot();
  if (current.ownerUserId !== key.owner) throw new Error('Approval owner not verified');
  return body;
}
