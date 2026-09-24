'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  executeRecoveryOperation,
  markConversationBound,
  prepareRecoveryOperation,
  type RecoveryIdentity,
  type RecoveryLoadState,
  type RecoveryPhase,
  readRecoveryState,
} from './cloud-binding-recovery-operations';

interface IdentityScopedRecoveryState {
  readKey: string;
  loadState: RecoveryLoadState;
  selectedConversationId: string | null;
  showChoices: boolean;
  phase: RecoveryPhase;
  operationError: string | null;
}

function loadingState(readKey: string): IdentityScopedRecoveryState {
  return {
    readKey,
    loadState: { kind: 'loading' },
    selectedConversationId: null,
    showChoices: false,
    phase: 'idle',
    operationError: null,
  };
}

function selectRecoveryConversation(
  nextState: RecoveryLoadState,
  identityKey: string,
  selection: { identityKey: string; conversationId: string | null },
): string | null {
  if (nextState.kind !== 'ready') return null;
  if (nextState.boundConversationId) return nextState.boundConversationId;
  if (
    selection.identityKey === identityKey &&
    nextState.candidates.some((candidate) => candidate.conversationId === selection.conversationId)
  ) {
    return selection.conversationId;
  }
  return nextState.candidates.length === 1 ? (nextState.candidates[0]?.conversationId ?? null) : null;
}

export function useCloudBindingRecovery(identity: RecoveryIdentity) {
  const { threadId, sourceMessageId, targetCatId, attemptId } = identity;
  const identityKey = `${identity.threadId}\u0000${identity.sourceMessageId}\u0000${identity.targetCatId}\u0000${identity.attemptId ?? ''}`;
  const currentIdentityRef = useRef(identityKey);
  const operationGenerationRef = useRef(0);
  const busyRef = useRef(false);
  const selectionRef = useRef<{ identityKey: string; conversationId: string | null }>({
    identityKey,
    conversationId: null,
  });
  const pollStartedAt = useRef(0);
  const pollIdentityKeyRef = useRef(identityKey);
  const titleSyncRequestedRef = useRef<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const recoveryReadKey = `${identityKey}\u0000${refreshGeneration}`;
  const currentReadKeyRef = useRef(recoveryReadKey);
  const [state, setState] = useState<IdentityScopedRecoveryState>(() => loadingState(recoveryReadKey));
  const stateIsCurrent = state.readKey === recoveryReadKey;
  const projectedState = stateIsCurrent ? state : loadingState(recoveryReadKey);

  currentIdentityRef.current = identityKey;
  currentReadKeyRef.current = recoveryReadKey;
  if (pollIdentityKeyRef.current !== identityKey) {
    pollIdentityKeyRef.current = identityKey;
    pollStartedAt.current = 0;
  }
  if (stateIsCurrent && state.loadState.kind === 'ready')
    selectionRef.current = { identityKey, conversationId: state.selectedConversationId };

  useEffect(() => {
    const controller = new AbortController();
    const generation = operationGenerationRef.current + 1;
    operationGenerationRef.current = generation;
    busyRef.current = false;
    setState(loadingState(recoveryReadKey));

    if (identity.deliveryStatus === 'sent') return () => controller.abort();

    const syncTitles = titleSyncRequestedRef.current === identityKey;
    titleSyncRequestedRef.current = null;
    void readRecoveryState({ threadId, sourceMessageId, targetCatId, attemptId }, controller.signal, syncTitles)
      .then((nextState) => {
        if (
          !nextState ||
          controller.signal.aborted ||
          operationGenerationRef.current !== generation ||
          currentReadKeyRef.current !== recoveryReadKey
        ) {
          return;
        }
        const selected = selectRecoveryConversation(nextState, identityKey, selectionRef.current);
        setState({
          readKey: recoveryReadKey,
          loadState: nextState,
          selectedConversationId: selected,
          showChoices: nextState.kind === 'ready' && nextState.candidates.length > 1 && selected === null,
          phase: 'idle',
          operationError: null,
        });
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          operationGenerationRef.current === generation &&
          currentReadKeyRef.current === recoveryReadKey
        ) {
          setState({
            ...loadingState(recoveryReadKey),
            loadState: { kind: 'error', message: '暂时无法读取已授权会话' },
          });
        }
      });

    return () => {
      controller.abort();
      operationGenerationRef.current += 1;
      busyRef.current = false;
    };
  }, [threadId, sourceMessageId, targetCatId, attemptId, recoveryReadKey, identityKey, identity.deliveryStatus]);

  const refresh = useCallback(() => setRefreshGeneration((current) => current + 1), []);
  const refreshTitles = useCallback(() => {
    if (busyRef.current || projectedState.loadState.kind === 'loading') return;
    busyRef.current = true;
    titleSyncRequestedRef.current = identityKey;
    refresh();
  }, [identityKey, projectedState.loadState.kind, refresh]);
  const pendingDelivery =
    projectedState.phase === 'queued' ||
    (projectedState.loadState.kind === 'ready' && projectedState.loadState.retryState === 'pending');
  useEffect(() => {
    if (!pendingDelivery || identity.deliveryStatus === 'sent') return;
    if (!pollStartedAt.current) pollStartedAt.current = Date.now();
    if (Date.now() - pollStartedAt.current >= 30_000) return;
    const timer = setInterval(() => {
      if (Date.now() - pollStartedAt.current >= 30_000) {
        clearInterval(timer);
        return;
      }
      refresh();
    }, 1500);
    return () => clearInterval(timer);
  }, [pendingDelivery, identity.deliveryStatus, refresh]);
  const selectConversation = useCallback(
    (conversationId: string) => {
      setState((current) =>
        current.readKey === recoveryReadKey
          ? { ...current, selectedConversationId: conversationId, operationError: null }
          : current,
      );
    },
    [recoveryReadKey],
  );

  const bindAndRetry = useCallback(async () => {
    if (state.readKey !== recoveryReadKey) return;
    const attemptId = state.loadState.kind === 'ready' ? state.loadState.hydratedAttemptId : undefined;
    const prepared = prepareRecoveryOperation({
      loadState: state.loadState,
      selectedConversationId: state.selectedConversationId,
      attemptId,
      busy: busyRef.current,
    });
    if (!prepared) return;

    const generation = operationGenerationRef.current + 1;
    operationGenerationRef.current = generation;
    const isCurrent = () => operationGenerationRef.current === generation && currentIdentityRef.current === identityKey;
    busyRef.current = true;
    pollStartedAt.current = Date.now();
    setState((current) => (current.readKey === recoveryReadKey ? { ...current, operationError: null } : current));
    const outcome = await executeRecoveryOperation({
      identity,
      prepared,
      isCurrent,
      setPhase: (phase) =>
        setState((current) => (current.readKey === recoveryReadKey ? { ...current, phase } : current)),
      onBound: () =>
        setState((current) =>
          current.readKey === recoveryReadKey
            ? {
                ...current,
                loadState: markConversationBound(current.loadState, prepared.selected.conversationId),
              }
            : current,
        ),
    });
    if (!isCurrent()) return;
    busyRef.current = false;
    if (outcome.kind === 'queued' || outcome.kind === 'connected') {
      setState((current) => (current.readKey === recoveryReadKey ? { ...current, phase: outcome.kind } : current));
    }
    if (outcome.kind === 'reconcile') {
      setState((current) =>
        current.readKey === recoveryReadKey
          ? {
              ...current,
              phase: 'idle',
              operationError: '发送状态已变化，请查看这条消息的最新状态。',
            }
          : current,
      );
    }
    if (outcome.kind === 'error') {
      setState((current) =>
        current.readKey === recoveryReadKey ? { ...current, phase: 'idle', operationError: outcome.message } : current,
      );
    }
  }, [identity, identityKey, recoveryReadKey, state]);

  return {
    loadState: projectedState.loadState,
    selectedConversationId: projectedState.selectedConversationId,
    showChoices: projectedState.showChoices,
    phase: projectedState.phase,
    operationError: projectedState.operationError,
    attemptId: stateIsCurrent
      ? projectedState.loadState.kind === 'ready'
        ? projectedState.loadState.hydratedAttemptId
        : undefined
      : undefined,
    refresh,
    refreshTitles,
    selectConversation,
    toggleChoices: () =>
      setState((current) =>
        current.readKey === recoveryReadKey ? { ...current, showChoices: !current.showChoices } : current,
      ),
    bindAndRetry,
  };
}
