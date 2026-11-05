'use client';

import { getFeatureDemo } from '@cat-cafe/shared';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { recordFeatureDemoStage } from '@/lib/feature-demo-telemetry';
import { openFeatureDemoTrial } from '@/lib/feature-demo-trial';
import { type FeatureDemoSession, useFeatureDemoStore } from '@/stores/featureDemoStore';

function timeLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function FeatureDemoPlayer({ session, close }: { session: FeatureDemoSession; close: () => void }) {
  const demo = getFeatureDemo(session.demoId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [failed, setFailed] = useState(false);
  const trialController = useRef<AbortController | null>(null);
  const [trying, setTrying] = useState(false);
  const [tryFailed, setTryFailed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const origin = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      trialController.current?.abort();
      dialog?.close();
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true });
    };
  }, []);

  if (!demo) return null;
  const tryDemo = async () => {
    if (trying) return;
    setTrying(true);
    setTryFailed(false);
    recordFeatureDemoStage(session, 'tried');
    trialController.current = new AbortController();
    const opened = await openFeatureDemoTrial(demo.tryPrompt, trialController.current.signal);
    setTrying(false);
    if (opened) close();
    else setTryFailed(true);
  };
  const handleKey = (event: KeyboardEvent<HTMLDialogElement>) => {
    // Prevent global Chat shortcuts from acting while watching, including Escape.
    event.stopPropagation();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={handleKey}
      className="m-auto w-[min(48rem,calc(100%-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-cafe bg-cafe-surface p-0 text-cafe-black shadow-xl backdrop:bg-[var(--console-overlay-backdrop)]"
    >
      {/* biome-ignore lint/a11y/useMediaCaption: The published film has burned-in Chinese captions and a music-only soundtrack. */}
      <video
        key={attempt}
        ref={videoRef}
        aria-label={`${demo.title}演示`}
        className="aspect-video w-full bg-cafe-surface-elevated"
        src={demo.src}
        poster={demo.poster}
        controls
        autoPlay
        playsInline
        preload="metadata"
        onPlay={() => recordFeatureDemoStage(session, 'started')}
        onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
        onEnded={(event) => {
          const played = event.currentTarget.played;
          let watched = 0;
          for (let index = 0; index < played.length; index++) watched += played.end(index) - played.start(index);
          // Seeking straight to the end is not a completed viewing.
          if (watched >= demo.durationSeconds * 0.9) recordFeatureDemoStage(session, 'completed');
        }}
        onError={() => setFailed(true)}
      />
      {failed && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-cafe p-4 text-sm text-cafe-secondary"
        >
          <span>演示暂时无法播放，可以重试或直接试用。</span>
          <button
            type="button"
            className="text-cafe-accent underline"
            onClick={() => {
              setFailed(false);
              setElapsed(0);
              setAttempt((n) => n + 1);
            }}
          >
            重试播放
          </button>
        </div>
      )}
      {tryFailed && (
        <p role="alert" className="px-4 pt-4 text-sm text-cafe-secondary">
          暂时无法打开试用，请重试；原草稿仍保留。
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 p-4">
        <h2 id={titleId} className="mr-auto text-sm font-medium">
          {demo.title} · {timeLabel(elapsed)} / {timeLabel(demo.durationSeconds)}
        </h2>
        <button
          type="button"
          onClick={tryDemo}
          disabled={trying}
          className="rounded-md bg-cafe-accent px-3 py-2 text-sm font-medium text-[var(--cafe-accent-foreground)] hover:opacity-90"
        >
          {trying ? '正在打开…' : '立即试用'}
        </button>
        <button
          type="button"
          onClick={close}
          className="rounded-md border border-cafe px-3 py-2 text-sm text-cafe-secondary hover:bg-cafe-surface-elevated"
        >
          关闭
        </button>
      </div>
    </dialog>
  );
}

export function FeatureDemoHost() {
  const session = useFeatureDemoStore((state) => state.session);
  const close = useFeatureDemoStore((state) => state.close);
  if (!session) return null;
  return createPortal(
    <FeatureDemoPlayer key={`${session.tipId}:${session.demoId}`} session={session} close={close} />,
    document.body,
  );
}
