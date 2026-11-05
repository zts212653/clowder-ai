import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity, observeApiSessionOwner } from '@/utils/api-session-identity';
import { approvalResultRead } from './approval-result-read';

let ownerRead: Promise<string | null> | null = null;
let lastOwner = apiSessionIdentity.getSnapshot().ownerUserId;
let eventsInstalled = false;
apiSessionIdentity.subscribe(() => {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId;
  if (lastOwner && owner !== lastOwner) approvalResultRead.clearOwner(lastOwner);
  lastOwner = owner;
});

/** Explicit/write preflights keep their original fresh owner read. It also fences every shared display consumer. */
export async function readFreshApprovalResultOwner(signal?: AbortSignal): Promise<string | null> {
  const before = apiSessionIdentity.getSnapshot();
  try {
    const response = await apiFetch('/api/session', { signal }, { afterCurrentGet: true });
    const body: unknown = response.ok ? await response.json() : null;
    signal?.throwIfAborted();
    const owner =
      body && typeof body === 'object' && 'userId' in body && typeof body.userId === 'string' && body.userId.trim()
        ? body.userId
        : null;
    const current = apiSessionIdentity.getSnapshot();
    if (current.generation !== before.generation && current.ownerUserId !== owner) return null;
    observeApiSessionOwner(owner);
    return owner;
  } catch {
    if (!signal?.aborted && apiSessionIdentity.getSnapshot().generation === before.generation)
      observeApiSessionOwner(null);
    return null;
  }
}

/** The normal API bootstrap supplies this identity. A cold standalone surface shares one owner read. */
export function readApprovalResultOwner(): Promise<string | null> {
  installApprovalResultEvents();
  const current = apiSessionIdentity.getSnapshot().ownerUserId;
  if (current) return Promise.resolve(current);
  if (ownerRead) return ownerRead;
  const generation = apiSessionIdentity.getSnapshot().generation;
  const pending = apiFetch('/api/session')
    .then(async (response) => {
      const body: unknown = response.ok ? await response.json() : null;
      const owner =
        body && typeof body === 'object' && 'userId' in body && typeof body.userId === 'string' ? body.userId : null;
      const observed = apiSessionIdentity.getSnapshot();
      // Bootstrap may have installed this same owner while its shared session GET was in flight.
      if (observed.generation !== generation && observed.ownerUserId !== owner) return null;
      observeApiSessionOwner(owner);
      return owner;
    })
    .catch(() => {
      if (apiSessionIdentity.getSnapshot().generation === generation) observeApiSessionOwner(null);
      return null;
    })
    .finally(() => {
      if (ownerRead === pending) ownerRead = null;
    });
  ownerRead = pending;
  return pending;
}

export function installApprovalResultEvents(): void {
  if (eventsInstalled || typeof window === 'undefined') return;
  eventsInstalled = true;
  const invalidate = (event: Event) => {
    const detail = (event as CustomEvent<Record<string, unknown>>).detail;
    const proposalId =
      detail &&
      (typeof detail.proposalId === 'string'
        ? detail.proposalId
        : typeof detail.interactionId === 'string'
          ? detail.interactionId
          : undefined);
    approvalResultRead.invalidate({ proposalId });
    approvalResultRead.invalidate({ producer: 'F246' });
  };
  for (const name of ['cat-cafe:proposal-updated', 'cat-cafe:proposal-created', 'cat-cafe:runtime-interaction-updated'])
    window.addEventListener(name, invalidate);
}
