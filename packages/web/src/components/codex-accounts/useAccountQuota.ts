'use client';
import { type AccountQuotaObservation, accountQuotaOwnerMatches, type CodexAccountIdentity } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { accountRequest } from './account-request';

export function useAccountQuota({
  accountRef,
  observation: supplied,
  reload,
  managed = false,
  identity,
}: {
  accountRef: string;
  observation?: AccountQuotaObservation;
  reload: () => Promise<void>;
  managed?: boolean;
  identity?: CodexAccountIdentity;
}) {
  const [busy, setBusy] = useState(false);
  const [stored, setStored] = useState(supplied);
  const [error, setError] = useState('');
  const current = useRef({ accountRef, identity });
  current.current = { accountRef, identity };
  const observation = managed && !accountQuotaOwnerMatches(stored, accountRef, identity) ? undefined : stored;
  useEffect(() => {
    setStored((previous) => {
      if (managed && !accountQuotaOwnerMatches(previous, accountRef, identity)) return supplied;
      if (
        previous?.status === 'ok' &&
        (!supplied || supplied.status !== 'ok' || supplied.observedAt < previous.observedAt)
      )
        return previous;
      return supplied;
    });
  }, [supplied, accountRef, managed, identity]);
  async function query() {
    if (busy) return;
    const requestedRef = accountRef;
    setBusy(true);
    setError('');
    try {
      const result = await accountRequest<{ quota: AccountQuotaObservation }>(
        `/api/accounts/${encodeURIComponent(accountRef)}/codex/quota`,
        {},
      );
      if (current.current.accountRef !== requestedRef) return;
      if (managed && !accountQuotaOwnerMatches(result.quota, accountRef, current.current.identity))
        throw new Error('账号登录已变化，请重新查询');
      if (result.quota.status !== 'ok' || result.quota.items.length === 0)
        throw new Error(result.quota.error || '无法查询额度');
      setStored(result.quota);
      void reload();
    } catch (e) {
      if (current.current.accountRef === requestedRef) setError(e instanceof Error ? e.message : '无法查询额度');
    } finally {
      setBusy(false);
    }
  }
  return { observation, busy, error, query };
}
