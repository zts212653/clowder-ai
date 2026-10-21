'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { type PlatformOperationStatus } from '../../HubConfigIcons';
import { ActionPanelBody, type ActionPhase, ConnectedBanner, type ResultState } from './ActionRendererParts';
import {
  type ActionApiResult,
  type ActionRendererTarget,
  actionCallFailure,
  actionRequest,
  classifyPollResult,
  deriveActionState,
  operationResetRequest,
  phaseForAction,
  toResultState,
} from './ActionRendererState';
import {
  awaitingOwnerMessage,
  confirmedActionRequest,
  invocationAllowed,
  useActionConfirmation,
} from './actionConfirmation';
import { LiveStatusActionRenderer } from './LiveStatusActionRenderer';
import { OperationRowsRenderer } from './OperationRowsRenderer';
import { useActionPollingSession } from './useActionPollingSession';

export interface ActionRendererProps {
  target: ActionRendererTarget;
  /** Operation definition + state from the status API. */
  operation: PlatformOperationStatus;
  /** Platform-level configured state; used when legacy config exists before operation state. */
  configured?: boolean;
  /** Unsaved config field values from the current card, used by validation actions. */
  pendingConfigValues?: Readonly<Record<string, string>>;
  /** Called after connect/disconnect lifecycle completes. */
  onStatusChange?: () => void;
  /** Platform theme color for the primary action button. */
  themeColor?: string;
}

export function ActionRenderer(props: ActionRendererProps) {
  const actions = props.operation.actions;
  // F202 W2-3 h1: an operation that lists rows is rendered as a row list with per-row actions.
  const listAction = actions.find((action) => action.resultRender === 'rows');
  if (listAction) return <OperationRowsRenderer {...props} listAction={listAction} />;
  const firstAction = actions[0];
  const revokeAction = actions.find(
    (action) => action.render === 'button' && action.next === firstAction?.id && firstAction.next === action.id,
  );
  const statusAction = actions.find((action) => action.render === 'status' || action.render === 'polling');
  // The live-status renderer checks its status action by itself, so it cannot take one that asks
  // for confirmation; such an operation stays on the sequenced renderer, which never runs it alone.
  if (firstAction?.render === 'button' && statusAction && statusAction.confirm === undefined && revokeAction) {
    return (
      <LiveStatusActionRenderer
        {...props}
        armAction={firstAction}
        statusAction={statusAction}
        revokeAction={revokeAction}
      />
    );
  }
  return <SequencedActionRenderer {...props} />;
}

function SequencedActionRenderer({
  target,
  operation,
  configured,
  pendingConfigValues,
  onStatusChange,
  themeColor,
}: ActionRendererProps) {
  const actions = operation.actions;
  const firstAction = actions[0];
  const disconnectAction = actions.find((a) => a.id !== firstAction?.id && a.next === firstAction?.id);
  const disconnectId = disconnectAction?.id;
  const initialState = deriveActionState(operation, actions, configured, disconnectId, firstAction?.id);

  const [phase, setPhase] = useState<ActionPhase>(() => initialState.phase);
  const [lastResult, setLastResult] = useState<ResultState | undefined>(() => initialState.lastResult);
  const [currentActionId, setCurrentActionId] = useState(() => initialState.currentActionId);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const { pollRef, expireRef, beginRequest, beginPolling, retainsSnapshot, stopTimers } = useActionPollingSession();
  const abortedRef = useRef(false);
  const autoStartedRef = useRef(false);
  const requestEpoch = useRef(0);
  const pollingInputKey = JSON.stringify([target, operation.name, actions, configured, pendingConfigValues ?? {}]);
  const confirmAction = useActionConfirmation();

  useEffect(
    () => () => {
      requestEpoch.current += 1;
      abortedRef.current = true;
      stopTimers();
    },
    [stopTimers],
  );
  useEffect(() => {
    if (lastResult?.render !== 'status') return;
    const timer = setTimeout(() => setLastResult(undefined), 4000);
    return () => clearTimeout(timer);
  }, [lastResult]);

  useEffect(() => {
    const nextState = deriveActionState(operation, actions, configured, disconnectId, firstAction?.id);
    if (retainsSnapshot(nextState.currentActionId, pollingInputKey, operation.updatedAt)) return;
    requestEpoch.current += 1;
    abortedRef.current = true;
    stopTimers();
    autoStartedRef.current = false;
    setCurrentActionId(nextState.currentActionId);
    setLastResult(nextState.lastResult);
    setPhase(nextState.phase);
    setErrorMsg(null);
  }, [pollingInputKey, actions, retainsSnapshot, configured, disconnectId, firstAction?.id, operation, stopTimers]);

  /** Every request goes through here; `confirmed` is true only right after the owner confirmed. */
  const executeAction = useCallback(
    async (actionId: string, confirmed = false): Promise<ActionApiResult | null> => {
      const action = actions.find((a) => a.id === actionId);
      if (action && !invocationAllowed(action.confirm, confirmed)) {
        return { ok: false, label: awaitingOwnerMessage(action.label) };
      }
      try {
        const request = actionRequest(target, operation.name, actionId, pendingConfigValues);
        const res = await apiFetch(request.url, confirmedActionRequest(request.init, action?.confirm, confirmed));
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { ok: false, label: (err as { error?: string }).error ?? 'Request failed' };
        }
        return (await res.json()) as ActionApiResult;
      } catch {
        return null;
      }
    },
    [actions, operation.name, pendingConfigValues, target],
  );

  const resetOperation = useCallback(async (): Promise<boolean> => {
    try {
      const request = operationResetRequest(target, operation.name);
      const res = await apiFetch(request.url, request.init);
      return res.ok;
    } catch {
      return false;
    }
  }, [operation.name, target]);

  /** Transition to the next action's phase after a successful result. */
  const advanceTo = useCallback(
    (nextId: string) => {
      setCurrentActionId(nextId);
      setPhase(phaseForAction(nextId, actions, disconnectId));
      onStatusChange?.();
    },
    [actions, disconnectId, onStatusChange],
  );

  const startPolling = useCallback(
    (actionId: string, intervalMs = 2500, restoredUpdatedAt?: number) => {
      beginPolling(actionId, pollingInputKey, restoredUpdatedAt);
      abortedRef.current = false;

      const action = actions.find((a) => a.id === actionId);
      const timeoutMs = (action?.timeout ?? 60) * 1000;
      const elapsedMs = typeof restoredUpdatedAt === 'number' ? Math.max(0, Date.now() - restoredUpdatedAt) : 0;
      const remainingTimeoutMs = timeoutMs - elapsedMs;

      const epoch = requestEpoch.current;
      const poll = async () => {
        if (abortedRef.current || epoch !== requestEpoch.current) return;
        const result = await executeAction(actionId);
        if (abortedRef.current || epoch !== requestEpoch.current) return;

        const verdict = classifyPollResult(result, action?.render);
        if (verdict.outcome === 'retry') {
          pollRef.current = setTimeout(poll, intervalMs);
          return;
        }
        if (verdict.outcome === 'error') {
          stopTimers();
          setPhase('error');
          setErrorMsg(verdict.message);
          return;
        }
        if (verdict.outcome === 'terminal') {
          stopTimers();
          if (action?.rollback) {
            void resetOperation().finally(() => {
              onStatusChange?.();
            });
            setCurrentActionId(action.rollback);
            setLastResult(undefined);
          } else {
            setLastResult(verdict.state);
          }
          setPhase('error');
          setErrorMsg(verdict.message);
          return;
        }
        if (verdict.outcome === 'continue') {
          // P1-2 fix: don't overwrite img result with bare polling status —
          // only update lastResult if the poll carries visual data (e.g. label change)
          if (verdict.state.render !== 'polling' && verdict.state.render !== 'status') {
            setLastResult(verdict.state);
          }
          pollRef.current = setTimeout(poll, intervalMs);
          return;
        }
        // done — always update result
        setLastResult(verdict.state);
        stopTimers();
        if (action?.next) advanceTo(action.next);
      };

      const expire = () => {
        abortedRef.current = true;
        stopTimers();
        if (action?.rollback) {
          void resetOperation().finally(() => {
            onStatusChange?.();
          });
          setCurrentActionId(action.rollback);
          setLastResult(undefined);
          setPhase('idle');
          setErrorMsg('Operation timed out. Please try again.');
          return;
        }
        setLastResult(undefined);
        setPhase('error');
        setErrorMsg('Operation timed out. Please try again.');
      };

      if (remainingTimeoutMs <= 0) {
        expire();
        return;
      }

      pollRef.current = setTimeout(poll, 100);
      expireRef.current = setTimeout(expire, remainingTimeoutMs);
    },
    [
      actions,
      beginPolling,
      advanceTo,
      executeAction,
      expireRef,
      onStatusChange,
      pollRef,
      pollingInputKey,
      resetOperation,
      stopTimers,
    ],
  );

  useEffect(() => {
    if (phase === 'polling' && currentActionId && !autoStartedRef.current && !pollRef.current) {
      autoStartedRef.current = true;
      startPolling(currentActionId, undefined, operation.updatedAt);
    }
  }, [phase, currentActionId, operation.updatedAt, pollRef, startPolling]);

  const handleAction = useCallback(
    async (actionId: string) => {
      const action = actions.find((a) => a.id === actionId);
      if (!action || !(await confirmAction(action.label, action.confirm))) return;

      const nextDef = actions.find((candidate) => candidate.id === action.next);
      if (nextDef?.render === 'polling') beginRequest(actionId, nextDef.id, pollingInputKey, operation.updatedAt);
      const epoch = ++requestEpoch.current;
      setLastResult(undefined);
      setPhase('loading');
      setErrorMsg(null);
      const result = await executeAction(actionId, true);
      if (epoch !== requestEpoch.current) return;
      const failure = actionCallFailure(result);
      if (!result || failure !== null) {
        stopTimers();
        setPhase('error');
        setErrorMsg(failure);
        return;
      }
      setLastResult(toResultState(result));

      if (nextDef?.render === 'polling') {
        setCurrentActionId(nextDef.id);
        setPhase('polling');
        startPolling(nextDef.id);
      } else if (action.next) {
        advanceTo(action.next);
      } else {
        setPhase('result');
      }
    },
    [
      actions,
      advanceTo,
      beginRequest,
      confirmAction,
      executeAction,
      operation.updatedAt,
      pollingInputKey,
      startPolling,
      stopTimers,
    ],
  );

  const handleDisconnect = useCallback(async () => {
    if (!disconnectAction || !(await confirmAction(disconnectAction.label, disconnectAction.confirm))) return;
    const epoch = ++requestEpoch.current;
    setLastResult(undefined);
    setPhase('disconnecting');
    setErrorMsg(null);

    const result = await executeAction(disconnectAction.id, true);
    if (epoch !== requestEpoch.current) return;
    if (!result || !result.ok) {
      setPhase('connected');
      return;
    }
    setCurrentActionId(firstAction?.id ?? '');
    setLastResult(undefined);
    setPhase('idle');
    onStatusChange?.();
  }, [confirmAction, disconnectAction, executeAction, firstAction, onStatusChange]);

  if (phase === 'connected' || phase === 'disconnecting') {
    return (
      <ConnectedBanner
        connectorId={target.id}
        label={lastResult?.label ?? 'Connected'}
        disconnectLabel={disconnectAction?.label}
        disconnecting={phase === 'disconnecting'}
        onDisconnect={disconnectAction ? handleDisconnect : undefined}
      />
    );
  }

  const currentAction = actions.find((a) => a.id === currentActionId) ?? firstAction;

  return (
    <ActionPanelBody
      connectorId={target.id}
      phase={phase}
      currentAction={currentAction}
      lastResult={lastResult}
      errorMsg={errorMsg}
      themeColor={themeColor}
      onAction={handleAction}
    />
  );
}
