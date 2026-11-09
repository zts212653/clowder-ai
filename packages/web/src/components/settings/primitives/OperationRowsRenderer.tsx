/**
 * OperationRowsRenderer — an operation whose list action returns a `rows` result (F202 W2-3 h1).
 *
 * Each row shows its label and detail and the actions the Host validated for it. A row action
 * calls the plugin with that row's input; a declared confirmation is asked first in the shared
 * Console dialog; the row being acted on is disabled while it runs and shows its own error. An
 * action whose `next` is the list action refreshes the list when it succeeds. The Host lists by
 * itself (on mount and after such an action) only when the list action asks for no confirmation.
 */

'use client';

import type { PluginOperationRow, PluginOperationRowAction, PluginOperationRows } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { PlatformActionDef } from '../../HubConfigIcons';
import type { ActionRendererProps } from './ActionRenderer';
import { type ActionApiResult, actionCallFailure, actionRequest, rowActionRequest } from './ActionRendererState';
import { ActionResultLink } from './ActionResultLink';
import {
  awaitingOwnerMessage,
  confirmedActionRequest,
  invocationAllowed,
  useActionConfirmation,
} from './actionConfirmation';
import { CopyableActionText } from './CopyableActionText';

type ObservablePluginOperationRows = PluginOperationRows & {
  readonly validUntil?: number;
  readonly pollUntil?: number;
};

/** The Host has already validated a rows result against the manifest; this only reads its shape. */
function rowsFrom(result: { render?: string; data?: unknown } | undefined): ObservablePluginOperationRows | undefined {
  if (result?.render !== 'rows' || result.data === null || typeof result.data !== 'object') return undefined;
  return Array.isArray((result.data as { rows?: unknown }).rows)
    ? (result.data as ObservablePluginOperationRows)
    : undefined;
}

/** Copies without `key`: state updates never mutate the current value. */
function withoutKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys);
  next.delete(key);
  return next;
}

function withoutError(errors: ReadonlyMap<string, string>, key: string): ReadonlyMap<string, string> {
  const next = new Map(errors);
  next.delete(key);
  return next;
}

function actionFeedback(
  result: ActionApiResult | null,
): { readonly text: string; readonly persistent: boolean; readonly copyText?: string } | null {
  if (!result) return null;
  const renderedData =
    result.render === 'text' || result.render === 'status'
      ? typeof result.data === 'string'
        ? result.data
        : result.data === undefined
          ? undefined
          : JSON.stringify(result.data, null, 2)
      : undefined;
  const parts = [result.label, renderedData].filter(
    (value, index, values): value is string =>
      typeof value === 'string' && value.length > 0 && values.indexOf(value) === index,
  );
  return parts.length === 0
    ? null
    : {
        text: parts.join('\n'),
        persistent: renderedData !== undefined,
        ...(result?.render === 'text' && typeof result.data === 'string' ? { copyText: result.data } : {}),
      };
}

function rowActionFeedback(
  result: ActionApiResult | null,
  rowKey: string,
  next: string | undefined,
  listActionId: string,
) {
  const feedback = actionFeedback(result);
  return feedback ? { ...feedback, rowKey: next === listActionId ? undefined : rowKey } : null;
}

const buttonClass =
  'rounded-lg border border-cafe-border px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:bg-cafe-surface-sunken disabled:opacity-50';
const EXTERNAL_OBSERVATION_INTERVAL_MS = 2500;
const MAX_EXTERNAL_OBSERVATION_MS = 5 * 60_000;

export function OperationRowsRenderer({
  target,
  operation,
  onStatusChange,
  refreshRevision,
  listAction,
  pendingConfigValues,
}: ActionRendererProps & { listAction: PlatformActionDef }) {
  const stableTarget = useMemo(() => ({ kind: target.kind, id: target.id }) as typeof target, [target.kind, target.id]);
  const [rows, setRows] = useState<ObservablePluginOperationRows | undefined>();
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{
    text: string;
    rowKey?: string;
    persistent?: boolean;
    copyText?: string;
  } | null>(null);
  const [actionResult, setActionResult] = useState<{ result: ActionApiResult; rowKey?: string } | null>(null);
  const [awaitingOwner, setAwaitingOwner] = useState(false);
  const [expiredObservationKey, setExpiredObservationKey] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  // Row keys are plugin data; a Map keeps keys such as `__proto__` or `toString` ordinary.
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const confirmAction = useActionConfirmation();
  const listRequestId = useRef(0);
  const listAbort = useRef<AbortController>();
  const operationEpoch = useRef(0);
  const ownerActionSequence = useRef(0);
  const latestOwnerAction = useRef(0);
  const ownerActionsInFlight = useRef(new Set<number>());
  const reconcileAfterOwnerActions = useRef(false);
  const activeProposalValidUntil = useRef<number>();
  // Detail refreshes change runtime timestamps, not the declared operation or this receipt.
  const inputKey = JSON.stringify([stableTarget, operation.name, operation.actions, operation.rowActions]);
  // Polling is automatically observed; explicitly confirmed reads remain owner actions.
  const automaticStatus = listAction.render === 'polling' && !listAction.confirm;
  const configKey = JSON.stringify(pendingConfigValues ?? {});
  const previousConfigKey = useRef(configKey);
  const previousRefreshRevision = useRef(refreshRevision);

  const invalidateListRequests = useCallback((updateState = true) => {
    listRequestId.current += 1;
    listAbort.current?.abort();
    listAbort.current = undefined;
    if (updateState) setListing(false);
  }, []);

  const acceptRows = useCallback((next: ObservablePluginOperationRows, restartObservation = false) => {
    const now = Date.now();
    activeProposalValidUntil.current = next.validUntil;
    const nextKey = next.rows.map(({ key }) => key).join('\u0000');
    setExpiredObservationKey((current) => (restartObservation || current !== nextKey ? null : current));
    setRows((current) => {
      const currentKey = current?.rows.map(({ key }) => key).join('\u0000');
      const currentDeadline = !restartObservation && currentKey === nextKey ? current?.pollUntil : undefined;
      const pollUntil =
        next.pollUntil === undefined
          ? undefined
          : Math.min(next.pollUntil, now + MAX_EXTERNAL_OBSERVATION_MS, currentDeadline ?? Number.POSITIVE_INFINITY);
      return {
        ...next,
        ...(pollUntil === undefined || pollUntil <= now ? { pollUntil: undefined } : { pollUntil }),
      };
    });
  }, []);

  /** Every request goes through here; `confirmed` is true only right after the owner confirmed. */
  const send = useCallback(
    async (
      declared: string | undefined,
      request: { url: string; init: RequestInit },
      confirmed: boolean,
    ): Promise<ActionApiResult | null> => {
      if (!invocationAllowed(declared, confirmed)) return null;
      // All owner actions pass here after confirmation; automatic next:list uses false.
      if (confirmed) setActionMessage(null);
      try {
        const response = await apiFetch(request.url, confirmedActionRequest(request.init, declared, confirmed));
        const body = (await response.json().catch(() => ({}))) as ActionApiResult & { error?: string };
        if (!response.ok) return { ok: false, label: body.error ?? 'Request failed' };
        return body;
      } catch {
        return { ok: false, label: 'Network error' };
      }
    },
    [],
  );

  const list = useCallback(
    async (confirmed: boolean, restartObservation = false) => {
      if (ownerActionsInFlight.current.size > 0) return;
      const epoch = operationEpoch.current;
      const id = ++listRequestId.current;
      listAbort.current?.abort();
      const controller = new AbortController();
      listAbort.current = controller;
      setListError(null);
      setListing(true);
      const request = actionRequest(stableTarget, operation.name, listAction.id);
      const result = await send(
        listAction.confirm,
        { ...request, init: { ...request.init, signal: controller.signal } },
        confirmed,
      );
      if (id !== listRequestId.current || epoch !== operationEpoch.current) return;
      listAbort.current = undefined;
      setListing(false);
      setAwaitingOwner(result === null);
      if (result === null) return;
      const next = result.ok ? rowsFrom(result) : undefined;
      if (next) acceptRows(next, restartObservation);
      else setListError(result.label ?? 'The list is unavailable');
    },
    [acceptRows, listAction.confirm, listAction.id, operation.name, send, stableTarget],
  );

  useEffect(() => {
    // `list` intentionally depends only on the callable list action. The serialized
    // identity also resets rows when a sibling/row declaration changes in place.
    void inputKey;
    operationEpoch.current += 1;
    ownerActionsInFlight.current.clear();
    reconcileAfterOwnerActions.current = false;
    activeProposalValidUntil.current = undefined;
    invalidateListRequests();
    setRows(undefined);
    setActionMessage(null);
    setActionResult(null);
    setBusyKeys(new Set());
    setRowErrors(new Map());
    setExpiredObservationKey(null);
    void list(false);
    return () => {
      invalidateListRequests(false);
      operationEpoch.current += 1;
    };
  }, [invalidateListRequests, list, inputKey]);

  useEffect(() => {
    if (previousRefreshRevision.current === refreshRevision) return;
    previousRefreshRevision.current = refreshRevision;
    if (ownerActionsInFlight.current.size > 0) reconcileAfterOwnerActions.current = true;
    // A sibling action restarts observation; its confirmation cannot authorize this action.
    else void list(false, true);
  }, [list, refreshRevision]);

  useEffect(() => {
    if (previousConfigKey.current === configKey) return;
    previousConfigKey.current = configKey;
    operationEpoch.current += 1;
    ownerActionsInFlight.current.clear();
    reconcileAfterOwnerActions.current = false;
    activeProposalValidUntil.current = undefined;
    invalidateListRequests();
    setRows(undefined);
    setListing(false);
    setListError(null);
    setActionMessage(null);
    setActionResult(null);
    setBusyKeys(new Set());
    setRowErrors(new Map());
    setExpiredObservationKey(null);
    // Invalidation removes stale proposals and aborts old reads. A passive status
    // must then resume observation; it has no permanent manual refresh control.
    if (automaticStatus) void list(false, true);
  }, [automaticStatus, configKey, invalidateListRequests, list]);

  useEffect(() => {
    if (actionMessage === null || actionMessage.persistent) return;
    const timer = setTimeout(() => setActionMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [actionMessage]);

  useEffect(() => {
    if (rows?.validUntil === undefined) return;
    const remaining = rows.validUntil - Date.now();
    const expire = () => {
      activeProposalValidUntil.current = undefined;
      reconcileAfterOwnerActions.current = ownerActionsInFlight.current.size > 0;
      setRows(undefined);
      void list(false);
    };
    if (remaining <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  }, [list, rows?.validUntil]);

  useEffect(() => {
    const pollUntil = rows?.pollUntil;
    if (pollUntil === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const poll = () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      const remaining = pollUntil - Date.now();
      if (remaining <= 0) {
        setExpiredObservationKey(rows?.rows.map(({ key }) => key).join('\u0000') ?? null);
        void list(false);
        return;
      }
      timer = setTimeout(() => void list(false).finally(poll), Math.min(EXTERNAL_OBSERVATION_INTERVAL_MS, remaining));
    };
    const visibility = () => {
      if (timer) clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        invalidateListRequests();
        return;
      }
      void list(false).finally(poll);
    };
    document.addEventListener('visibilitychange', visibility);
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [invalidateListRequests, list, rows?.pollUntil, rows?.rows]);

  const refresh = useCallback(async () => {
    const epoch = operationEpoch.current;
    if ((await confirmAction(listAction.label, listAction.confirm)) && epoch === operationEpoch.current) {
      setActionResult(null);
      await list(true, true);
    }
  }, [confirmAction, list, listAction.confirm, listAction.label]);

  const applySuccessfulResult = useCallback(
    async (result: ActionApiResult | null, next: string | undefined, deferList: boolean) => {
      const replacement = rowsFrom(result ?? undefined);
      if (replacement) {
        acceptRows(replacement);
        return;
      }
      if (next !== listAction.id) return;
      if (deferList) reconcileAfterOwnerActions.current = true;
      else await list(false);
    },
    [acceptRows, list, listAction.id],
  );

  const settle = useCallback(
    async (
      result: ActionApiResult | null,
      label: string,
      next: string | undefined,
      applySharedResult = true,
      deferList = false,
    ): Promise<string | null> => {
      const failure = result === null ? awaitingOwnerMessage(label) : actionCallFailure(result);
      if (failure !== null) return failure;
      onStatusChange?.();
      const replacement = rowsFrom(result ?? undefined);
      if (!applySharedResult) {
        if (replacement || next === listAction.id) reconcileAfterOwnerActions.current = true;
        return null;
      }
      await applySuccessfulResult(result, next, deferList);
      return null;
    },
    [applySuccessfulResult, listAction.id, onStatusChange],
  );

  const reconcileIfIdle = useCallback(async () => {
    if (ownerActionsInFlight.current.size > 0 || !reconcileAfterOwnerActions.current) return;
    if (activeProposalValidUntil.current !== undefined) return;
    reconcileAfterOwnerActions.current = false;
    await list(false);
  }, [list]);

  const completeRowAction = useCallback(
    async (
      epoch: number,
      actionId: number,
      rowKey: string,
      label: string,
      next: string | undefined,
      result: ActionApiResult | null,
    ) => {
      ownerActionsInFlight.current.delete(actionId);
      if (epoch !== operationEpoch.current) return;
      const latest = actionId === latestOwnerAction.current;
      const otherActionPending = ownerActionsInFlight.current.size > 0;
      const failure = await settle(result, label, next, latest, otherActionPending);
      if (failure === null && latest && otherActionPending) reconcileAfterOwnerActions.current = true;
      if (epoch !== operationEpoch.current) return;
      if (failure !== null) setRowErrors((current) => new Map(current).set(rowKey, failure));
      else if (latest) {
        setActionMessage(rowActionFeedback(result, rowKey, next, listAction.id));
        if (result) setActionResult({ result, ...(next === listAction.id ? {} : { rowKey }) });
      }
      setBusyKeys((current) => withoutKey(current, rowKey));
      await reconcileIfIdle();
    },
    [listAction.id, reconcileIfIdle, settle],
  );

  const runRowAction = useCallback(
    async (row: PluginOperationRow, rowAction: PluginOperationRowAction) => {
      const declared = operation.rowActions?.find((candidate) => candidate.id === rowAction.action);
      if (!declared) return;
      const label = rowAction.label ?? declared.label;
      const confirmationEpoch = operationEpoch.current;
      if (
        !(await confirmAction(label, declared.confirm, rowAction.confirm)) ||
        confirmationEpoch !== operationEpoch.current
      )
        return;
      const epoch = operationEpoch.current;
      const actionId = ++ownerActionSequence.current;
      latestOwnerAction.current = actionId;
      invalidateListRequests();
      ownerActionsInFlight.current.add(actionId);
      setBusyKeys((current) => new Set(current).add(row.key));
      setActionResult(null);
      setRowErrors((current) => withoutError(current, row.key));
      const request = rowActionRequest(stableTarget, operation.name, declared.id, rowAction.input);
      const result = await send(rowAction.confirm ?? declared.confirm, request, true);
      await completeRowAction(epoch, actionId, row.key, label, declared.next, result);
    },
    [
      completeRowAction,
      confirmAction,
      invalidateListRequests,
      operation.name,
      operation.rowActions,
      send,
      stableTarget,
    ],
  );

  const completeButtonAction = useCallback(
    async (epoch: number, actionId: number, action: PlatformActionDef, result: ActionApiResult | null) => {
      ownerActionsInFlight.current.delete(actionId);
      if (epoch !== operationEpoch.current) return;
      const latest = actionId === latestOwnerAction.current;
      const otherActionPending = ownerActionsInFlight.current.size > 0;
      const failure = await settle(result, action.label, action.next, latest, otherActionPending);
      if (failure === null && latest && otherActionPending) reconcileAfterOwnerActions.current = true;
      if (epoch !== operationEpoch.current) return;
      if (latest && failure !== null) setListError(failure);
      if (latest && failure === null) {
        setActionMessage(actionFeedback(result));
        if (result) setActionResult({ result });
      }
      await reconcileIfIdle();
    },
    [reconcileIfIdle, settle],
  );

  const runButton = useCallback(
    async (action: PlatformActionDef) => {
      const confirmationEpoch = operationEpoch.current;
      if (!(await confirmAction(action.label, action.confirm)) || confirmationEpoch !== operationEpoch.current) return;
      const epoch = operationEpoch.current;
      const actionId = ++ownerActionSequence.current;
      latestOwnerAction.current = actionId;
      invalidateListRequests();
      ownerActionsInFlight.current.add(actionId);
      setListError(null);
      setActionResult(null);
      const result = await send(action.confirm, actionRequest(stableTarget, operation.name, action.id), true);
      await completeButtonAction(epoch, actionId, action, result);
    },
    [completeButtonAction, confirmAction, invalidateListRequests, operation.name, send, stableTarget],
  );

  const buttons = operation.actions.filter((action) => action.id !== listAction.id && action.render !== 'row');
  const proposalPending = rows?.validUntil !== undefined;
  const observationPaused =
    expiredObservationKey !== null && expiredObservationKey === rows?.rows.map(({ key }) => key).join('\u0000');
  const showRefresh = !proposalPending && (!automaticStatus || Boolean(listError) || observationPaused);
  const refreshLabel = automaticStatus ? '重新检查' : listAction.label;

  const abandonProposal = useCallback(() => {
    activeProposalValidUntil.current = undefined;
    reconcileAfterOwnerActions.current = false;
    setRows(undefined);
    void list(false);
  }, [list]);

  return (
    <div className="space-y-2" data-testid={`${target.id}-rows`}>
      {(showRefresh || proposalPending || buttons.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {showRefresh && (
            <button
              type="button"
              disabled={listing}
              onClick={() => void refresh()}
              className={buttonClass}
              data-testid={`${target.id}-rows-refresh`}
            >
              {refreshLabel}
            </button>
          )}
          {proposalPending && (
            <button
              type="button"
              disabled={listing}
              onClick={abandonProposal}
              className={buttonClass}
              data-testid={`${target.id}-rows-abandon`}
            >
              放弃本次准备
            </button>
          )}
          {buttons.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={listing}
              onClick={() => void runButton(action)}
              className={buttonClass}
              data-testid={`${target.id}-action-${action.id}`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      {automaticStatus && listing && !rows && (
        <p role="status" className="text-xs text-cafe-muted">
          正在读取状态…
        </p>
      )}
      {listError && (
        <p role="alert" className="text-xs text-conn-red-text">
          {listError}
        </p>
      )}
      {actionMessage && actionMessage.rowKey === undefined && (
        <output className="block text-xs text-cafe-secondary">
          <CopyableActionText
            text={actionMessage.text}
            copyText={actionMessage.copyText}
            className="whitespace-pre-wrap break-words font-sans"
          />
        </output>
      )}
      {awaitingOwner && (
        <p className="text-xs text-cafe-muted" data-testid={`${target.id}-rows-awaiting-owner`}>
          {awaitingOwnerMessage(listAction.label)}
        </p>
      )}
      {actionResult && actionResult.rowKey === undefined && (
        <ActionResultLink result={actionResult.result} testId={`${target.id}-result-link`} />
      )}
      {observationPaused && (
        <p className="text-xs text-cafe-secondary" data-testid={`${target.id}-rows-observation-paused`}>
          自动检查已到本次等待上限；现有证据仍保留。点“{refreshLabel}”可重新检查。
        </p>
      )}
      {rows && rows.rows.length === 0 && (
        <p className="text-sm text-cafe-muted" data-testid={`${target.id}-rows-empty`}>
          {rows.empty ?? 'Nothing to show yet.'}
        </p>
      )}
      {rows && rows.rows.length > 0 && (
        <ul className="divide-y divide-cafe-border rounded-lg border border-cafe-border">
          {rows.rows.map((row) => (
            <li key={row.key} className="px-3 py-2" data-testid={`${target.id}-row-${row.key}`}>
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
                <div className="w-full min-w-0 sm:w-auto sm:flex-1">
                  <p className="break-words text-sm font-medium">{row.label}</p>
                  {row.detail && <p className="break-all text-xs text-cafe-secondary">{row.detail}</p>}
                </div>
                <div className="flex flex-wrap gap-2 sm:shrink-0">
                  {(row.actions ?? []).map((rowAction) => {
                    const declared = operation.rowActions?.find((candidate) => candidate.id === rowAction.action);
                    if (!declared) return null;
                    return (
                      <button
                        key={rowAction.action}
                        type="button"
                        disabled={busyKeys.has(row.key)}
                        onClick={() => void runRowAction(row, rowAction)}
                        className={buttonClass}
                        data-testid={`${target.id}-row-${row.key}-action-${rowAction.action}`}
                      >
                        {rowAction.label ?? declared.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {actionMessage?.rowKey === row.key && (
                <output className="mt-1 block text-xs text-cafe-secondary">
                  <CopyableActionText
                    text={actionMessage.text}
                    copyText={actionMessage.copyText}
                    className="whitespace-pre-wrap break-words font-sans"
                  />
                </output>
              )}
              {actionResult?.rowKey === row.key && (
                <ActionResultLink result={actionResult.result} testId={`${target.id}-row-${row.key}-result-link`} />
              )}
              {rowErrors.has(row.key) && (
                <p
                  role="alert"
                  className="mt-1 text-xs text-conn-red-text"
                  data-testid={`${target.id}-row-${row.key}-error`}
                >
                  {rowErrors.get(row.key)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
