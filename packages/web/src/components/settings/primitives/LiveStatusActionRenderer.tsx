'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { PlatformActionDef } from '../../HubConfigIcons';
import type { ActionRendererProps } from './ActionRenderer';
import { type ActionApiResult, actionRequest } from './ActionRendererState';

interface AuthorizationStatus {
  armed: boolean;
  expiresAt?: number;
  label: string;
}

function parseAuthorization(result: ActionApiResult): AuthorizationStatus | null {
  if (!result.ok || result.render !== 'status' || !result.data || typeof result.data !== 'object') return null;
  const data = result.data as { armed?: unknown; expiresAt?: unknown; remainingMs?: unknown };
  if (typeof data.armed !== 'boolean') return null;
  if (!data.armed) return { armed: false, label: result.label ?? 'Not authorized' };
  const expiresAt = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : Number.NaN;
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    typeof data.remainingMs !== 'number' ||
    data.remainingMs <= 0
  ) {
    return { armed: false, label: 'Not authorized' };
  }
  return { armed: true, expiresAt, label: result.label ?? 'Authorized' };
}

/** A status action is the only source of truth for time-bounded authorization. */
export function LiveStatusActionRenderer({
  target,
  operation,
  armAction,
  statusAction,
  revokeAction,
  onStatusChange,
  themeColor,
}: ActionRendererProps & {
  armAction: PlatformActionDef;
  statusAction: PlatformActionDef;
  revokeAction: PlatformActionDef;
}) {
  const [status, setStatus] = useState<AuthorizationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);
  const stableTarget = useMemo(() => ({ kind: target.kind, id: target.id }) as typeof target, [target.kind, target.id]);

  const run = useCallback(
    async (actionId: string): Promise<ActionApiResult | null> => {
      try {
        const request = actionRequest(stableTarget, operation.name, actionId);
        const response = await apiFetch(request.url, request.init);
        if (!response.ok) return null;
        return (await response.json()) as ActionApiResult;
      } catch {
        return null;
      }
    },
    [stableTarget, operation.name],
  );

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    const result = await run(statusAction.id);
    if (id !== requestId.current) return;
    const next = result && parseAuthorization(result);
    setNow(Date.now());
    setStatus(next);
    setError(next ? null : 'Authorization status is unavailable');
  }, [run, statusAction.id]);

  useEffect(() => {
    void refresh();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const requests = requestId;
    return () => {
      requests.current++;
      clearInterval(tick);
    };
  }, [refresh]);

  useEffect(() => {
    if (expiryTimer.current) clearTimeout(expiryTimer.current);
    if (status?.armed && status.expiresAt) {
      expiryTimer.current = setTimeout(
        () => {
          setStatus(null);
          void refresh();
        },
        Math.max(0, status.expiresAt - Date.now()),
      );
    }
    return () => {
      if (expiryTimer.current) clearTimeout(expiryTimer.current);
    };
  }, [status, refresh]);

  const perform = useCallback(
    async (actionId: string) => {
      setBusy(true);
      setError(null);
      const result = await run(actionId);
      if (!result?.ok) {
        setError(result?.label ?? 'Action failed');
      } else {
        await refresh();
        onStatusChange?.();
      }
      setBusy(false);
    },
    [onStatusChange, refresh, run],
  );

  const armed = status?.armed && status.expiresAt !== undefined && status.expiresAt > now;
  const remainingSeconds = armed ? Math.ceil((status.expiresAt! - now) / 1000) : 0;
  return (
    <div className="space-y-2" data-testid={`${target.id}-authorization-status`}>
      <p className="text-sm" aria-live="polite">
        {status === null
          ? 'Checking authorization…'
          : armed
            ? `${status.label} · ${remainingSeconds}s remaining`
            : status.label}
      </p>
      {error && (
        <p role="alert" className="text-xs text-conn-red-text">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={busy || status === null}
        onClick={() => void perform(armed ? revokeAction.id : armAction.id)}
        data-testid={armed ? `${target.id}-disconnect` : `${target.id}-action-${armAction.id}`}
        className="rounded-lg px-4 py-2 text-sm font-semibold text-[var(--cafe-surface)] disabled:opacity-50"
        style={{ backgroundColor: themeColor ?? 'var(--conn-blue-text)' }}
      >
        {armed ? revokeAction.label : armAction.label}
      </button>
    </div>
  );
}
