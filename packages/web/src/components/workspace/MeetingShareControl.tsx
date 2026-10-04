'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface ShareIntent {
  callId: string;
  generation: number;
  captureThreadId: string;
  meetingId: string;
  captureStartedAt: number;
  inputId: string;
  inputLabel: string;
}

type Preview =
  | { kind: 'unavailable' }
  | { kind: 'available'; intent: ShareIntent; catId: string; inputLabel: string; sharing: boolean };

const ROUTE = '/api/concierge/meeting-share';

/** Share controls live beside the F195 capture they describe. */
export function MeetingShareControl() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusUnconfirmed, setStatusUnconfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (afterCurrentGet = false) => {
    try {
      const response = await apiFetch(ROUTE, undefined, { afterCurrentGet });
      if (!response.ok) {
        setStatusUnconfirmed(true);
        return;
      }
      const next = (await response.json()) as Preview;
      setPreview(next.kind === 'available' || next.kind === 'unavailable' ? next : { kind: 'unavailable' });
      setStatusUnconfirmed(false);
    } catch {
      setStatusUnconfirmed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (method: 'POST' | 'DELETE') => {
    if (preview?.kind !== 'available' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(ROUTE, {
        method,
        ...(method === 'POST'
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preview.intent) }
          : {}),
      });
      if (!response.ok) {
        setError(
          method === 'POST'
            ? 'The call or capture changed. Refresh and try again.'
            : 'Could not confirm sharing stopped.',
        );
      }
    } catch {
      setError('Could not confirm the private sharing status.');
    } finally {
      await refresh(true);
      setBusy(false);
    }
  };

  if (preview?.kind !== 'available') return null;
  const confirmedSharing = preview.sharing && !statusUnconfirmed;
  return (
    <section
      aria-label="Private call transcript sharing"
      className="border-b border-cafe-border bg-cafe-surface-secondary px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || (statusUnconfirmed && !preview.sharing)}
          onClick={() => void act(preview.sharing ? 'DELETE' : 'POST')}
          className="rounded border border-cafe-border px-2 py-1 text-xs text-cafe-text-primary hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
        >
          {busy ? 'Checking…' : preview.sharing ? 'Stop sharing' : 'Share transcript'}
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-cafe-text-primary" title={preview.inputLabel}>
          {preview.inputLabel}
        </span>
      </div>
      <p className="mt-1 text-xs text-cafe-text-secondary">
        {confirmedSharing
          ? 'Sharing with this private call. Stop sharing anytime.'
          : 'Share this session’s existing and new transcript with this private cat call. Nothing is sent into the meeting.'}
      </p>
      {statusUnconfirmed && (
        <p className="mt-1 text-xs text-conn-amber-text">
          Sharing status unavailable. Stop sharing or stop capture to revoke.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-conn-red-text">
          {error}
        </p>
      )}
    </section>
  );
}
