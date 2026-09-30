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
import { awaitingOwnerMessage, invocationAllowed, useActionConfirmation } from './actionConfirmation';

/** The Host has already validated a rows result against the manifest; this only reads its shape. */
function rowsFrom(result: { render?: string; data?: unknown } | undefined): PluginOperationRows | undefined {
  if (result?.render !== 'rows' || result.data === null || typeof result.data !== 'object') return undefined;
  return Array.isArray((result.data as { rows?: unknown }).rows) ? (result.data as PluginOperationRows) : undefined;
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

const buttonClass =
  'rounded-lg border border-cafe-border px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:bg-cafe-surface-sunken disabled:opacity-50';

export function OperationRowsRenderer({
  target,
  operation,
  onStatusChange,
  listAction,
}: ActionRendererProps & { listAction: PlatformActionDef }) {
  const stableTarget = useMemo(() => ({ kind: target.kind, id: target.id }) as typeof target, [target.kind, target.id]);
  const [rows, setRows] = useState<PluginOperationRows | undefined>(() => rowsFrom(operation.lastResult));
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [awaitingOwner, setAwaitingOwner] = useState(false);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  // Row keys are plugin data; a Map keeps keys such as `__proto__` or `toString` ordinary.
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const confirmAction = useActionConfirmation();
  const listRequestId = useRef(0);

  /** Every request goes through here; `confirmed` is true only right after the owner confirmed. */
  const send = useCallback(
    async (
      declared: string | undefined,
      request: { url: string; init: RequestInit },
      confirmed: boolean,
    ): Promise<ActionApiResult | null> => {
      if (!invocationAllowed(declared, confirmed)) return null;
      try {
        const response = await apiFetch(request.url, request.init);
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
    async (confirmed: boolean) => {
      const id = ++listRequestId.current;
      setListError(null);
      setListing(true);
      const result = await send(
        listAction.confirm,
        actionRequest(stableTarget, operation.name, listAction.id),
        confirmed,
      );
      if (id !== listRequestId.current) return;
      setListing(false);
      setAwaitingOwner(result === null);
      if (result === null) return;
      const next = result.ok ? rowsFrom(result) : undefined;
      if (next) setRows(next);
      else setListError(result.label ?? 'The list is unavailable');
    },
    [listAction.confirm, listAction.id, operation.name, send, stableTarget],
  );

  useEffect(() => {
    void list(false);
  }, [list]);

  const refresh = useCallback(async () => {
    if (await confirmAction(listAction.label, listAction.confirm)) await list(true);
  }, [confirmAction, list, listAction.confirm, listAction.label]);

  const settle = useCallback(
    async (result: ActionApiResult | null, label: string, next: string | undefined): Promise<string | null> => {
      const failure = result === null ? awaitingOwnerMessage(label) : actionCallFailure(result);
      if (failure !== null) return failure;
      onStatusChange?.();
      if (next === listAction.id) await list(false);
      return null;
    },
    [list, listAction.id, onStatusChange],
  );

  const runRowAction = useCallback(
    async (row: PluginOperationRow, rowAction: PluginOperationRowAction) => {
      const declared = operation.rowActions?.find((candidate) => candidate.id === rowAction.action);
      if (!declared) return;
      const label = rowAction.label ?? declared.label;
      if (!(await confirmAction(label, declared.confirm, rowAction.confirm))) return;
      setBusyKeys((current) => new Set(current).add(row.key));
      setRowErrors((current) => withoutError(current, row.key));
      const request = rowActionRequest(stableTarget, operation.name, declared.id, rowAction.input);
      const result = await send(rowAction.confirm ?? declared.confirm, request, true);
      const failure = await settle(result, label, declared.next);
      if (failure !== null) setRowErrors((current) => new Map(current).set(row.key, failure));
      setBusyKeys((current) => withoutKey(current, row.key));
    },
    [confirmAction, operation.name, operation.rowActions, send, settle, stableTarget],
  );

  const runButton = useCallback(
    async (action: PlatformActionDef) => {
      if (!(await confirmAction(action.label, action.confirm))) return;
      setListError(null);
      const result = await send(action.confirm, actionRequest(stableTarget, operation.name, action.id), true);
      const failure = await settle(result, action.label, action.next);
      if (failure !== null) setListError(failure);
    },
    [confirmAction, operation.name, send, settle, stableTarget],
  );

  const buttons = operation.actions.filter((action) => action.render === 'button' && action.id !== listAction.id);

  return (
    <div className="space-y-2" data-testid={`${target.id}-rows`}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={listing}
          onClick={() => void refresh()}
          className={buttonClass}
          data-testid={`${target.id}-rows-refresh`}
        >
          {listAction.label}
        </button>
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
      {listError && (
        <p role="alert" className="text-xs text-conn-red-text">
          {listError}
        </p>
      )}
      {awaitingOwner && (
        <p className="text-xs text-cafe-muted" data-testid={`${target.id}-rows-awaiting-owner`}>
          {awaitingOwnerMessage(listAction.label)}
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
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{row.label}</p>
                  {row.detail && <p className="break-all text-xs text-cafe-secondary">{row.detail}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
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
