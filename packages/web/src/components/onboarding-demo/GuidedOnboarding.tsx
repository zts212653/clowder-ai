'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DemoTeam } from './DemoTeam';
import { DemoTranscript } from './DemoTranscript';
import { DemoWorkProduct } from './DemoWorkProduct';
import { DEMO_EVENTS, DEMO_SETTINGS_URL, type DemoCat } from './demo-story';
import { beginOnboardingNavigation, finishOnboardingNavigation } from './onboarding-performance';
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
  const playback = useDemoPlayback(storageScope);
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
  const events = DEMO_EVENTS.slice(0, playback.index + 1);
  const current = DEMO_EVENTS[playback.index];
  const active =
    current && current.speaker !== 'user' && current.speaker !== 'system' ? (current.speaker as DemoCat) : undefined;
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
            <p className="text-xs font-medium text-cafe-accent">预置演示 · 不调用模型</p>
            <h2 id="guided-demo-title" className="mt-1 text-xl font-semibold">
              看猫猫一起把事情做好
            </h2>
            <p className="mt-1 text-xs leading-5 text-cafe-secondary">
              看看同一个页面如何被设计、实现和完善，再创建自己的团队。
            </p>
          </div>
          <button
            ref={close}
            type="button"
            aria-label="关闭引导"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-xl text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
          >
            ×
          </button>
        </header>
        <DemoTeam active={active} />
        <div className="flex min-h-10 items-center justify-between gap-2 border-y border-[var(--console-border-soft)] px-4 py-2 text-xs sm:px-6">
          <span role="status">
            {playback.finished
              ? '审查通过 · 试试团队交付的成果'
              : current
                ? `${playback.index + 1} / ${DEMO_EVENTS.length} · ${current.title}`
                : '正在准备协作演示…'}
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
              稍后再看
            </button>
            <div className="flex flex-wrap items-center gap-3">
              {playback.index >= 0 && !playback.finished && (
                <button
                  ref={playbackControl}
                  type="button"
                  onClick={playback.toggle}
                  className="rounded-full bg-cafe-accent px-5 py-2.5 text-sm font-semibold text-[var(--cafe-surface)]"
                >
                  {playback.paused ? '继续' : '暂停'}
                </button>
              )}
              {playback.finished && (
                <button type="button" onClick={replay} className="text-sm text-cafe-secondary">
                  重新看一遍
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
                {playback.finished && delivered ? '创建我的猫猫 →' : '直接创建我的猫猫 →'}
              </Link>
            </div>
          </div>
          {playback.finished && delivered && (
            <p className="mt-2 text-xs leading-5 text-cafe-secondary">
              成果已就绪。演示团队使用预置数据；你可以在设置中接入自己的工具，创建真实伙伴。
            </p>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
