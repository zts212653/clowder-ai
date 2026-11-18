'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import type { AccountSelection, AccountsResponse } from '../../hub-accounts.types';

export interface QuotaRingDirectorySnapshot {
  readonly data?: AccountsResponse;
  readonly selection?: AccountSelection;
  readonly claudeSelection?: AccountSelection;
  readonly agySelection?: AccountSelection;
}

interface TurnTrackingShape {
  readonly hasActiveInvocation?: boolean;
  readonly activeInvocations?: Readonly<Record<string, unknown>>;
  readonly catStatuses?: Readonly<Record<string, unknown>>;
  readonly threadStates?: Readonly<Record<string, TurnTrackingShape>>;
}

function didSlotRelease(
  prevSlots?: Readonly<Record<string, unknown>>,
  nextSlots?: Readonly<Record<string, unknown>>,
): boolean {
  if (!prevSlots || prevSlots === nextSlots) return false;
  const current = nextSlots ?? {};
  return Object.keys(prevSlots).some((slotKey) => !(slotKey in current));
}

function didCatBecomeDone(
  prevStatuses?: Readonly<Record<string, unknown>>,
  nextStatuses?: Readonly<Record<string, unknown>>,
): boolean {
  if (!nextStatuses || prevStatuses === nextStatuses) return false;
  const previous = prevStatuses ?? {};
  return Object.entries(nextStatuses).some(([catId, status]) => status === 'done' && previous[catId] !== 'done');
}

function didScopeCompleteTurn(prev?: TurnTrackingShape, next?: TurnTrackingShape): boolean {
  if (!prev || !next) return false;
  return (
    Boolean(prev.hasActiveInvocation && !next.hasActiveInvocation) ||
    didSlotRelease(prev.activeInvocations, next.activeInvocations) ||
    didCatBecomeDone(prev.catStatuses, next.catStatuses)
  );
}

function didChatTurnComplete(prev: TurnTrackingShape, next: TurnTrackingShape): boolean {
  if (didScopeCompleteTurn(prev, next)) return true;
  if (next.threadStates && prev.threadStates !== next.threadStates) {
    const prevThreads = prev.threadStates ?? {};
    for (const [threadId, nextThread] of Object.entries(next.threadStates)) {
      const prevThread = prevThreads[threadId];
      if (prevThread !== nextThread && didScopeCompleteTurn(prevThread, nextThread)) {
        return true;
      }
    }
  }
  return false;
}

async function readJsonIfOk<T>(path: string): Promise<T | undefined> {
  try {
    const response = await apiFetch(path, undefined, { afterCurrentGet: true });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * Single-commit read for the WorldRail quota bars.
 * Stays silent when all endpoints are unavailable or unmocked in isolated shell tests.
 */
export function useQuotaRingData(options?: {
  onTurnComplete?: () => void;
}): QuotaRingDirectorySnapshot & { refresh: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<QuotaRingDirectorySnapshot>({});
  const generation = useRef(0);
  const onTurnCompleteRef = useRef(options?.onTurnComplete);
  onTurnCompleteRef.current = options?.onTurnComplete;

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const [accountsBody, codexBody, claudeBody, agyBody] = await Promise.all([
      readJsonIfOk<AccountsResponse>('/api/accounts'),
      readJsonIfOk<{ selection?: AccountSelection }>('/api/accounts/codex/members'),
      readJsonIfOk<{ selection?: AccountSelection }>('/api/accounts/claude/members'),
      readJsonIfOk<{ selection?: AccountSelection }>('/api/accounts/agy/members'),
    ]);
    if (current !== generation.current) return;
    const hasAccounts = Array.isArray(accountsBody?.providers);
    if (!hasAccounts && !codexBody?.selection && !claudeBody?.selection && !agyBody?.selection) {
      return;
    }
    setSnapshot((prev) => ({
      data: hasAccounts ? accountsBody : prev.data,
      selection: codexBody?.selection ?? prev.selection,
      claudeSelection: claudeBody?.selection ?? prev.claudeSelection,
      agySelection: agyBody?.selection ?? prev.agySelection,
    }));
  }, []);

  useEffect(() => {
    void refresh();
    let turnSettleTimer: ReturnType<typeof setTimeout> | null = null;
    const reconcile = () => {
      void refresh();
    };
    const unsubscribeChatStore =
      typeof useChatStore?.subscribe === 'function'
        ? useChatStore.subscribe((next, prev) => {
            if (!didChatTurnComplete(prev as TurnTrackingShape, next as TurnTrackingShape)) return;
            if (turnSettleTimer !== null) clearTimeout(turnSettleTimer);
            turnSettleTimer = setTimeout(() => {
              turnSettleTimer = null;
              onTurnCompleteRef.current?.();
              void refresh();
            }, 50);
          })
        : undefined;

    window.addEventListener('accounts-changed', reconcile);
    window.addEventListener('cat-config-changed', reconcile);
    return () => {
      generation.current++;
      if (turnSettleTimer !== null) clearTimeout(turnSettleTimer);
      unsubscribeChatStore?.();
      window.removeEventListener('accounts-changed', reconcile);
      window.removeEventListener('cat-config-changed', reconcile);
    };
  }, [refresh]);

  return { ...snapshot, refresh };
}
