'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { DemoTranscript } from './DemoTranscript';
import { DemoWorkProduct } from './DemoWorkProduct';
import { DEMO_SETTINGS_URL, getDemoEvents } from './demo-story';
import { beginOnboardingNavigation, finishOnboardingNavigation } from './onboarding-performance';
import { onboardingPlayerCopy } from './onboarding-player.shell-copy';
import { useDemoPlayback } from './useDemoPlayback';

interface Props {
  open: boolean;
  storageScope: string;
  onClose: () => void;
  onCompleted?: () => void;
}
export function GuidedOnboarding({ open, storageScope, onClose, onCompleted }: Props) {
  return open ? (
    <DemoPlayer key={storageScope} storageScope={storageScope} onClose={onClose} onCompleted={onCompleted} />
  ) : null;
}

function DemoPlayer({ storageScope, onClose, onCompleted }: Omit<Props, 'open'>) {
  useEffect(() => finishOnboardingNavigation('demo-open', 'ready'), []);
  const language = useShellLanguage();
  const t = useShellCopy(onboardingPlayerCopy);
  const timeline = useMemo(() => getDemoEvents(language), [language]);
  const playback = useDemoPlayback(storageScope, timeline);
  const [delivered, setDelivered] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const playbackControl = useRef<HTMLButtonElement>(null);
  const completionSent = useRef(false);
  const complete = useRef(onCompleted);
  complete.current = onCompleted;
  useEffect(() => {
    if (playback.finished && delivered && !completionSent.current) {
      completionSent.current = true;
      complete.current?.();
    }
  }, [playback.finished, delivered]);
  const started = playback.index >= 0;
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  useEffect(() => {
    // Starting/replaying or auto-finishing can remove the focused control.
    // Keep keyboard users in the dialog instead of returning to the background.
    if (started && document.activeElement === document.body) {
      (playback.finished ? close : playbackControl).current?.focus();
    }
  }, [started, playback.finished]);
  const events = timeline.slice(0, playback.index + 1);
  const current = timeline[playback.index];
  const completedEvents = playback.phase === 'complete' || playback.finished ? events : events.slice(0, -1);
  const stage = [...completedEvents].reverse().find((event) => event.artifact)?.artifact;
  const replay = () => {
    setDelivered(false);
    playback.start();
  };
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-medium)] p-2 backdrop-blur-sm sm:p-5">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guided-demo-title"
        className="flex h-[94dvh] max-h-[960px] w-full max-w-[1440px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] text-cafe shadow-2xl"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key !== 'Tab') return;
          const controls = [
            ...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], iframe') ?? []),
          ].filter((element) => element.getClientRects().length > 0);
          const first = controls[0],
            last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="flex items-start justify-between gap-3 px-4 pt-5 sm:px-6">
          <div>
            <p className="text-xs font-medium text-cafe-accent">{t.preset}</p>
            <h2 id="guided-demo-title" className="mt-1 text-xl font-semibold">
              {t.title}
            </h2>
            <p className="mt-1 text-xs leading-5 text-cafe-secondary">{t.intro}</p>
          </div>
          <button
            ref={close}
            type="button"
            aria-label={t.close}
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-xl text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
          >
            ×
          </button>
        </header>
        <div className="flex min-h-10 items-center justify-between gap-2 border-y border-[var(--console-border-soft)] px-4 py-2 text-xs sm:px-6">
          <span role="status">
            {playback.finished
              ? t.approved
              : current
                ? `${playback.index + 1} / ${timeline.length} · ${current.title}`
                : t.preparing}
          </span>
        </div>
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(120px,0.7fr)_minmax(190px,1fr)] md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:grid-rows-1">
          <DemoTranscript
            events={events}
            playing={!playback.paused}
            phase={playback.phase}
            characters={playback.characters}
          />
          <DemoWorkProduct stage={stage} onReady={() => setDelivered(true)} />
        </div>
        <footer className="border-t border-[var(--console-border-soft)] px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={onClose} className="text-sm text-cafe-secondary">
              {t.later}
            </button>
            <div className="flex flex-wrap items-center gap-3">
              {playback.index >= 0 && !playback.finished && (
                <button
                  ref={playbackControl}
                  type="button"
                  onClick={playback.toggle}
                  className="rounded-full bg-cafe-accent px-5 py-2.5 text-sm font-semibold text-[var(--cafe-surface)]"
                >
                  {playback.paused ? t.continue : t.pause}
                </button>
              )}
              {playback.finished && (
                <button type="button" onClick={replay} className="text-sm text-cafe-secondary">
                  {t.replay}
                </button>
              )}
              <Link
                href={DEMO_SETTINGS_URL}
                onClick={() => {
                  beginOnboardingNavigation('team-setup');
                  onClose();
                }}
                className={
                  playback.finished && delivered
                    ? 'rounded-full bg-cafe-accent px-4 py-2.5 text-sm font-semibold text-[var(--cafe-surface)]'
                    : 'rounded-full border border-[var(--console-border-soft)] px-4 py-2.5 text-sm text-cafe-accent'
                }
              >
                {playback.finished && delivered ? t.create : t.skip}
              </Link>
            </div>
          </div>
          {playback.finished && delivered && <p className="mt-2 text-xs leading-5 text-cafe-secondary">{t.ready}</p>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
