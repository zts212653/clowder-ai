'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { announceCloudBindingChange } from './cloud-binding-events';
import {
  executeRecoveryOperation,
  markBound,
  prepareRecoveryOperation,
  type RecoveryIdentity,
  type RecoveryLoadState,
  type RecoveryPhase,
  readRecoveryState,
} from './cloud-binding-recovery-operations';
import { useRecoveryBindingSession } from './useRecoveryBindingSync';

interface IdentityScopedRecoveryState {
  readKey: string;
  loadState: RecoveryLoadState;
  phase: RecoveryPhase;
  operationError: string | null;
}

function loadingState(readKey: string): IdentityScopedRecoveryState {
  return {
    readKey,
    loadState: { kind: 'loading' },
    phase: 'idle',
    operationError: null,
  };
}

export function useCloudBindingRecovery(
  identity: RecoveryIdentity,
  readGeneration = 1,
  initial?: Omit<IdentityScopedRecoveryState, 'readKey'>,
) {
  const { threadId, sourceMessageId, targetCatId, attemptId } = identity;
  const identityKey = `${identity.threadId}\u0000${identity.sourceMessageId}\u0000${identity.targetCatId}\u0000${identity.attemptId ?? ''}`;
  const terminalDelivery = identity.deliveryStatus === 'sent' || identity.deliveryStatus === 'failed';
  const currentIdentityRef = useRef(identityKey);
  const operationGenerationRef = useRef(0);
  const busyRef = useRef(false);
  const source = useId();
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const recoveryReadKey = `${identityKey}\u0000${refreshGeneration}`;
  const currentReadKeyRef = useRef(recoveryReadKey);
  const [state, setState] = useState<IdentityScopedRecoveryState>(() =>
    initial
      ? {
          readKey: recoveryReadKey,
          loadState: initial.loadState,
          phase: initial.phase,
          operationError: initial.operationError,
        }
      : loadingState(recoveryReadKey),
  );
  const stateIsCurrent = state.readKey === recoveryReadKey;
  const projectedState = state.readKey.startsWith(`${identityKey}\u0000`) ? state : loadingState(recoveryReadKey);

  currentIdentityRef.current = identityKey;
  currentReadKeyRef.current = recoveryReadKey;

  // The thread panel writes the same binding: what this card shows as bound follows the latest reading
  // — of this identity only; a reading made for the identity the card showed before never lands here.
  const showBinding = useCallback(
    (forIdentity: string, chatUrl: string | null) =>
      setState((current) =>
        current.readKey.startsWith(`${forIdentity}\u0000`) && current.loadState.kind === 'ready'
          ? { ...current, loadState: markBound(current.loadState, chatUrl) }
          : current,
      ),
    [],
  );
  const binding = useRecoveryBindingSession({
    identityKey,
    threadId,
    targetCatId,
    source,
    listening: !terminalDelivery,
    show: showBinding,
  });

  useEffect(() => {
    const controller = new AbortController();
    const generation = operationGenerationRef.current + 1;
    operationGenerationRef.current = generation;
    busyRef.current = false;
    setState((current) =>
      current.readKey.startsWith(`${identityKey}\u0000`)
        ? current.readKey === recoveryReadKey
          ? current
          : { ...current, readKey: recoveryReadKey }
        : loadingState(recoveryReadKey),
    );

    if (terminalDelivery) return () => controller.abort();

    const ticket = binding.beginRead();
    void readRecoveryState({ threadId, sourceMessageId, targetCatId, attemptId }, controller.signal)
      .then((read) => {
        if (
          !read ||
          controller.signal.aborted ||
          operationGenerationRef.current !== generation ||
          currentReadKeyRef.current !== recoveryReadKey
        ) {
          return;
        }
        setState({
          readKey: recoveryReadKey,
          loadState: read.kind === 'ready' ? markBound(read, binding.settleRead(ticket, read.boundChatUrl)) : read,
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
            loadState: { kind: 'error', message: '暂时无法读取当前 Thread 绑定' },
          });
        }
      });

    return () => {
      controller.abort();
      operationGenerationRef.current += 1;
      busyRef.current = false;
    };
  }, [
    threadId,
    sourceMessageId,
    targetCatId,
    attemptId,
    recoveryReadKey,
    readGeneration,
    identityKey,
    identity.deliveryStatus,
    terminalDelivery,
    binding,
  ]);

  const refresh = useCallback(() => setRefreshGeneration((current) => current + 1), []);

  // Binds the conversation the provider's plugin chose, then retries the exact source unless it only binds.
  const bindAndRetry = useCallback(
    async (chatUrl: string) => {
      if (terminalDelivery || currentIdentityRef.current !== identityKey || state.readKey !== recoveryReadKey) return;
      const attemptId = state.loadState.kind === 'ready' ? state.loadState.hydratedAttemptId : undefined;
      const prepared = prepareRecoveryOperation({
        loadState: state.loadState,
        chatUrl,
        attemptId,
        busy: busyRef.current,
      });
      if (!prepared) return;

      const generation = operationGenerationRef.current + 1;
      operationGenerationRef.current = generation;
      const isCurrent = () =>
        operationGenerationRef.current === generation && currentIdentityRef.current === identityKey;
      busyRef.current = true;
      setState((current) => (current.readKey === recoveryReadKey ? { ...current, operationError: null } : current));
      const outcome = await executeRecoveryOperation({
        identity,
        prepared,
        isCurrent,
        setPhase: (phase) =>
          setState((current) => (current.readKey === recoveryReadKey ? { ...current, phase } : current)),
        onWriteStart: binding.beginWrite,
        onWriteSettled: () => announceCloudBindingChange(threadId, source),
        onBound: () => {
          // Another surface wrote while this answer was out: the answer may be stale, so it is read again.
          if (!binding.writeLanded(prepared.chatUrl)) return;
          setState((current) =>
            current.readKey === recoveryReadKey
              ? { ...current, loadState: markBound(current.loadState, prepared.chatUrl) }
              : current,
          );
        },
      });
      // The session this operation began in: a card that now shows another identity is not touched.
      binding.operationEnded();
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
          current.readKey === recoveryReadKey
            ? { ...current, phase: 'idle', operationError: outcome.message }
            : current,
        );
      }
    },
    [identity, identityKey, recoveryReadKey, state, threadId, source, binding, terminalDelivery],
  );

  return {
    loadState: projectedState.loadState,
    phase: projectedState.phase,
    operationError: projectedState.operationError,
    attemptId: stateIsCurrent
      ? projectedState.loadState.kind === 'ready'
        ? projectedState.loadState.hydratedAttemptId
        : undefined
      : undefined,
    refresh,
    bindAndRetry,
  };
}
