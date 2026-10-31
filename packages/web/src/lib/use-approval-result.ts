'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { installApprovalResultEvents, readApprovalResultOwner } from './approval-result-owner';
import { type ApprovalResultKey, type ApprovalResultPart, approvalResultRead } from './approval-result-read';

const empty: ApprovalResultPart = { value: undefined, reading: false, failed: false, observedAt: null };

/** Presentation retains completed reads across unmounts. Original callers retain their validators and write guards. */
export function useApprovalResult<T>(
  producer: string,
  proposalId: string | null,
  part: string,
  load: (signal: AbortSignal, fresh?: boolean) => Promise<T>,
  expectedOwner?: string,
  readEnabled = true,
) {
  const identity = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  const owner = identity.ownerUserId;
  const [ownerUnavailable, setOwnerUnavailable] = useState(false);
  const allowed = !!owner && (!expectedOwner || owner === expectedOwner) && !!proposalId;
  const key: ApprovalResultKey = { owner: owner ?? '', producer, proposalId: proposalId ?? '' };
  const serialized = JSON.stringify(key);
  const loader = useRef(load);
  loader.current = load;
  // The serialized coordinate contains only identity; equivalent props never cause another read.
  const subscribe = useCallback(
    (listener: () => void) =>
      allowed ? approvalResultRead.subscribe(JSON.parse(serialized) as ApprovalResultKey, listener) : () => {},
    [allowed, serialized],
  );
  const get = useCallback(
    () =>
      allowed
        ? approvalResultRead.snapshot<T>(JSON.parse(serialized) as ApprovalResultKey, part)
        : (empty as ApprovalResultPart<T>),
    [allowed, serialized, part],
  );
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const getFacts = useCallback(
    () => (allowed ? approvalResultRead.factsVersion(JSON.parse(serialized) as ApprovalResultKey) : 0),
    [allowed, serialized],
  );
  const factsVersion = useSyncExternalStore(subscribe, getFacts, getFacts);
  useEffect(() => {
    installApprovalResultEvents();
    if (!owner && proposalId && readEnabled)
      void readApprovalResultOwner().then((value) => setOwnerUnavailable(value === null));
    else if (owner) setOwnerUnavailable(false);
  }, [owner, proposalId, readEnabled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: factsVersion withdraws derived projections even when the prior value is retained.
  useEffect(() => {
    if (allowed && readEnabled) {
      const key = JSON.parse(serialized) as ApprovalResultKey;
      const cause = approvalResultRead.isStale(key, part) ? 'facts' : 'read';
      void approvalResultRead
        .read(key, part, (signal, reason) => loader.current(signal, reason === 'refresh'), false, cause)
        .catch(() => {});
    }
  }, [allowed, serialized, part, readEnabled, factsVersion]);
  const refresh = useCallback(async () => {
    if (allowed)
      return approvalResultRead
        .read(
          JSON.parse(serialized) as ApprovalResultKey,
          part,
          (signal, cause) => loader.current(signal, cause !== 'facts'),
          true,
          'refresh',
        )
        .catch(() => undefined);
    else if (!owner && proposalId && readEnabled)
      void readApprovalResultOwner().then((value) => setOwnerUnavailable(value === null));
    else if (owner) setOwnerUnavailable(false);
  }, [allowed, serialized, part, owner, proposalId, readEnabled]);
  return {
    ...snapshot,
    failed: snapshot.failed || (!owner && ownerUnavailable),
    reading: snapshot.reading || (!owner && !ownerUnavailable && !!proposalId && readEnabled),
    ownerUserId: owner,
    stale: allowed && approvalResultRead.isStale(key, part),
    refresh,
  };
}
