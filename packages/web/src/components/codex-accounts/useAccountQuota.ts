'use client';
import { type AccountQuotaObservation, accountQuotaOwnerMatches, type CodexAccountIdentity } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { accountRequest } from './account-request';
import { quotaFailureKind } from './quota-state';

// Shared by remounted row controls, without keeping credentials or query results.
const automaticAttempts = new Map<string, string>();
function mergeObservation(previous: AccountQuotaObservation | undefined, next: AccountQuotaObservation | undefined) {
  if (!next) return previous;
  if (previous && previous.observedAt > next.observedAt) return previous;
  if (previous?.status === 'ok' && next.status === 'unavailable' && !next.lastSuccess)
    return { ...next, lastSuccess: { observedAt: previous.observedAt, items: previous.items } };
  return next;
}
export function useAccountQuota({
  accountRef,
  observation: supplied,
  reload,
  managed = false,
  identity,
  allowReading = true,
}: {
  accountRef: string;
  observation?: AccountQuotaObservation;
  reload: () => Promise<void>;
  managed?: boolean;
  identity?: CodexAccountIdentity;
  allowReading?: boolean;
}) {
  const context = `${accountRef}:${identity ? `${identity.userId}:${identity.workspaceId}` : managed ? 'unverified' : 'native'}`;
  const generation = useRef(0);
  const lastContext = useRef(context);
  if (lastContext.current !== context) {
    generation.current++;
    lastContext.current = context;
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = useRef({
    context,
    accountRef,
    identity,
    managed,
    reload,
    supplied,
    observation: supplied,
    generation: generation.current,
  });
  current.current = {
    context,
    accountRef,
    identity,
    managed,
    reload,
    supplied,
    observation: supplied,
    generation: generation.current,
  };
  const [state, setState] = useState({ context, observation: supplied });
  const [pending, setPending] = useState<{ context: string; automatic: boolean } | null>(null);
  const inFlight = useRef<{ ticket: symbol; context: string } | null>(null);
  const suppliedValid = !(managed || identity) || accountQuotaOwnerMatches(supplied, accountRef, identity);
  const local =
    state.context === context &&
    (!(managed || identity) || accountQuotaOwnerMatches(state.observation, accountRef, identity))
      ? state.observation
      : undefined;
  const observation = mergeObservation(suppliedValid ? supplied : undefined, local);
  current.current.observation = observation;
  useEffect(() => {
    setState((previous) => ({
      context,
      observation: suppliedValid
        ? mergeObservation(previous.context === context ? previous.observation : undefined, supplied)
        : undefined,
    }));
  }, [context, supplied, suppliedValid]);
  const query = useCallback(async (automatic = false) => {
    if (inFlight.current?.context === current.current.context) return;
    const requested = current.current;
    const ticket = Symbol();
    inFlight.current = { ticket, context: requested.context };
    setPending({ context: requested.context, automatic });
    try {
      const result = await accountRequest<{ quota: AccountQuotaObservation }>(
        `/api/accounts/${encodeURIComponent(requested.accountRef)}/codex/quota`,
        automatic
          ? { renewedCredentialVersion: requested.supplied?.renewedCredentialVersion }
          : requested.observation?.status === 'unavailable' &&
              quotaFailureKind(requested.observation) === 'renewal_required'
            ? { renewExpired: true }
            : {},
      );
      if (!mounted.current || generation.current !== requested.generation) return;
      if (
        (requested.managed || requested.identity) &&
        !accountQuotaOwnerMatches(result.quota, requested.accountRef, current.current.identity)
      )
        return;
      setState((previous) => ({
        context: requested.context,
        observation: mergeObservation(
          previous.context === requested.context ? previous.observation : undefined,
          result.quota,
        ),
      }));
      void current.current.reload();
    } catch (error) {
      if (!mounted.current || generation.current !== requested.generation) return;
      if (error instanceof Error && 'status' in error && error.status === 409) {
        void current.current.reload();
        return;
      }
      const failed: AccountQuotaObservation = {
        observedAt: Date.now(),
        status: 'unavailable',
        source: 'codex_official_readonly',
        items: [],
        failure: { kind: 'service_unreachable' },
        ...(requested.identity
          ? {
              owner: {
                accountRef: requested.accountRef,
                userId: requested.identity.userId,
                workspaceId: requested.identity.workspaceId,
              },
            }
          : {}),
      };
      setState((previous) => ({
        context: requested.context,
        observation: mergeObservation(previous.observation, failed),
      }));
    } finally {
      if (mounted.current && inFlight.current?.ticket === ticket) {
        inFlight.current = null;
        setPending(null);
      }
    }
  }, []);
  useEffect(() => {
    const version = supplied?.renewedCredentialVersion;
    if (
      !version ||
      !suppliedValid ||
      supplied?.status !== 'unavailable' ||
      pending ||
      (local &&
        (local.observedAt > supplied.observedAt ||
          local.credentialVersion === version ||
          (local.status === 'ok' && local.observedAt >= supplied.observedAt))) ||
      automaticAttempts.get(context) === version
    )
      return;
    automaticAttempts.set(context, version);
    void query(true);
  }, [supplied, context, pending, query, suppliedValid, local]);
  const reading = allowReading ? (observation?.status === 'ok' ? observation : observation?.lastSuccess) : undefined;
  return {
    observation,
    identityChanged: !!supplied?.owner && !suppliedValid,
    reading,
    busy: pending?.context === context,
    automatic: pending?.context === context && pending.automatic,
    query,
  };
}
