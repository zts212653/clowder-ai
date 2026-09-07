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

export function useCloudBindingRecovery(identity: RecoveryIdentity) {
  const { threadId, sourceMessageId, targetCatId, attemptId } = identity;
  const identityKey = `${identity.threadId}\u0000${identity.sourceMessageId}\u0000${identity.targetCatId}\u0000${identity.attemptId ?? ''}`;
  const currentIdentityRef = useRef(identityKey);
  const operationGenerationRef = useRef(0);
  const busyRef = useRef(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const recoveryReadKey = `${identityKey}\u0000${refreshGeneration}`;
  const currentReadKeyRef = useRef(recoveryReadKey);
  const [state, setState] = useState<IdentityScopedRecoveryState>(() => loadingState(recoveryReadKey));
  const stateIsCurrent = state.readKey === recoveryReadKey;
  const projectedState = stateIsCurrent ? state : loadingState(recoveryReadKey);

  currentIdentityRef.current = identityKey;
  currentReadKeyRef.current = recoveryReadKey;

  useEffect(() => {
    const controller = new AbortController();
    const generation = operationGenerationRef.current + 1;
    operationGenerationRef.current = generation;
    busyRef.current = false;
    setState(loadingState(recoveryReadKey));

    void readRecoveryState({ threadId, sourceMessageId, targetCatId, attemptId }, controller.signal)
      .then((nextState) => {
        if (
          !nextState ||
          controller.signal.aborted ||
          operationGenerationRef.current !== generation ||
          currentReadKeyRef.current !== recoveryReadKey
        ) {
          return;
        }
        const selected =
          nextState.kind === 'ready'
            ? (nextState.boundConversationId ??
              (nextState.candidates.length === 1 ? nextState.candidates[0]?.conversationId : null) ??
              null)
            : null;
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
  }, [threadId, sourceMessageId, targetCatId, attemptId, recoveryReadKey]);

  const refresh = useCallback(() => setRefreshGeneration((current) => current + 1), []);
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
    const attemptId =
      identity.attemptId ?? (state.loadState.kind === 'ready' ? state.loadState.hydratedAttemptId : undefined);
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
    if (outcome.kind === 'queued') {
      setState((current) => (current.readKey === recoveryReadKey ? { ...current, phase: 'queued' } : current));
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
      ? (identity.attemptId ??
        (projectedState.loadState.kind === 'ready' ? projectedState.loadState.hydratedAttemptId : undefined))
      : undefined,
    refresh,
    selectConversation,
    toggleChoices: () =>
      setState((current) =>
        current.readKey === recoveryReadKey ? { ...current, showChoices: !current.showChoices } : current,
      ),
    bindAndRetry,
  };
}
