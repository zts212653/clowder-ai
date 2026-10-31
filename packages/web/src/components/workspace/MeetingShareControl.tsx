'use client';

import { useCallback, useEffect, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { apiFetch } from '@/utils/api-client';
import { voiceMeetingCopy } from './voice-meeting.shell-copy';

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

type ShareErrorKind = 'callOrCaptureChanged' | 'stopUnconfirmed' | 'privateStatusUnconfirmed';

const ROUTE = '/api/concierge/meeting-share';

/**
 * The original English words, kept byte-identical for the classic shell (F317 owner ruling 2026-10-04:
 * only the v2 consumption reads the shell dictionary; classic keeps its original copy and lifecycle).
 */
const CLASSIC_SHARE = {
  regionLabel: 'Private call transcript sharing',
  checking: 'Checking…',
  stopSharing: 'Stop sharing',
  shareTranscript: 'Share transcript',
  sharingActive: 'Sharing with this private call. Stop sharing anytime.',
  shareDescription:
    'Share this session’s existing and new transcript with this private cat call. Nothing is sent into the meeting.',
  statusUnavailable: 'Sharing status unavailable. Stop sharing or stop capture to revoke.',
  callOrCaptureChanged: 'The call or capture changed. Refresh and try again.',
  stopUnconfirmed: 'Could not confirm sharing stopped.',
  privateStatusUnconfirmed: 'Could not confirm the private sharing status.',
} as const;

type ShareWords = Record<keyof typeof CLASSIC_SHARE, string>;

/**
 * The share controller: preview polling, POST/DELETE and the authorization lifecycle. It is presentation-blind —
 * no shell dictionary, no language preference — so classic mounts never read or subscribe to the v2 language
 * (review R3-P2), and switching language never re-runs a request.
 */
function useMeetingShareController() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusUnconfirmed, setStatusUnconfirmed] = useState(false);
  const [error, setError] = useState<ShareErrorKind | null>(null);

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
        setError(method === 'POST' ? 'callOrCaptureChanged' : 'stopUnconfirmed');
      }
    } catch {
      setError('privateStatusUnconfirmed');
    } finally {
      await refresh(true);
      setBusy(false);
    }
  };

  return { preview, busy, statusUnconfirmed, error, act };
}

function MeetingShareControlView({
  words,
  ctl,
}: {
  words: ShareWords;
  ctl: ReturnType<typeof useMeetingShareController>;
}) {
  const { preview, busy, statusUnconfirmed, error, act } = ctl;
  if (preview?.kind !== 'available') return null;
  const confirmedSharing = preview.sharing && !statusUnconfirmed;
  return (
    <section aria-label={words.regionLabel} className="border-b border-cafe-border bg-cafe-surface-secondary px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || (statusUnconfirmed && !preview.sharing)}
          onClick={() => void act(preview.sharing ? 'DELETE' : 'POST')}
          className="rounded border border-cafe-border px-2 py-1 text-xs text-cafe-text-primary hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
        >
          {busy ? words.checking : preview.sharing ? words.stopSharing : words.shareTranscript}
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-cafe-text-primary" title={preview.inputLabel}>
          {preview.inputLabel}
        </span>
      </div>
      <p className="mt-1 text-xs text-cafe-text-secondary">
        {confirmedSharing ? words.sharingActive : words.shareDescription}
      </p>
      {statusUnconfirmed && <p className="mt-1 text-xs text-conn-amber-text">{words.statusUnavailable}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs text-conn-red-text">
          {words[error]}
        </p>
      )}
    </section>
  );
}

/** Classic renders the original English constants only — it never touches the v2 dictionary (review R3-P2). */
function MeetingShareControlV2View({ ctl }: { ctl: ReturnType<typeof useMeetingShareController> }) {
  const t = useShellCopy(voiceMeetingCopy);
  return <MeetingShareControlView words={t.share} ctl={ctl} />;
}

/**
 * Share controls live beside the F195 capture they describe. The controller mounts HERE, at the stable shared
 * point (review R4-P2): a presentation switch only swaps which words render — the polling timer, an in-flight
 * POST/DELETE and `busy` all survive, so no second mutation can be fired mid-flight.
 */
export function MeetingShareControl() {
  const presentation = useShellPresentation();
  const ctl = useMeetingShareController();
  return presentation === 'v2' ? (
    <MeetingShareControlV2View ctl={ctl} />
  ) : (
    <MeetingShareControlView words={CLASSIC_SHARE} ctl={ctl} />
  );
}
