'use client';

import { useShellCopy } from '@/components/shell/shell-copy';
import { AudioHealthStrip } from './AudioHealthStrip';
import type { AudioStatus } from './audio-transcript-contract';
import { MeetingShareControl } from './MeetingShareControl';
import { voiceMeetingCopy } from './voice-meeting.shell-copy';

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 画中画 (picture-in-picture) — the pop-out affordance of §1.14; strictly not the full-window ⤢ glyph (gap-list #7). */
function PictureInPictureIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <rect x="8" y="8" width="5" height="3.5" rx="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

const pillButton = 'rounded-lg px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40';

/**
 * §1.14 语音 2/3/4 — the v2 capture header: a status dot, the session title (未在采集 → 会议伴随; live → the real
 * input labels; stopped → 已停止 · 共 N 分钟), live controls (暂停/继续/停止) or 重新开始, and the 画中画 pop-out.
 */
export function TranscriptCaptureHeaderV2({
  status,
  sourceLabel,
  elapsed,
  hasSession,
  onResume,
  onPause,
  onStop,
  onStartAgain,
  onPopOut,
}: {
  status: AudioStatus;
  sourceLabel: string;
  elapsed: number;
  hasSession: boolean;
  onResume(): void;
  onPause(): void;
  onStop(): void;
  onStartAgain(): void;
  onPopOut(): void;
}) {
  const t = useShellCopy(voiceMeetingCopy);

  const dot = status.running
    ? status.paused
      ? 'bg-[var(--semantic-warning)]'
      : 'bg-conn-green-text animate-pulse'
    : 'bg-cafe-text-muted';

  const title = status.running ? (status.paused ? t.capture.paused : sourceLabel) : t.meeting.title;
  const stateText = status.running ? null : hasSession ? stoppedText(t, elapsed) : t.meeting.notCapturing;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-cafe-border px-3 py-2">
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-cafe-text-primary">
          {title}
          {stateText && <span className="ml-2 text-xs font-normal text-cafe-text-secondary">{stateText}</span>}
        </span>
        {status.running && (
          <>
            <span className="shrink-0 font-mono text-xs text-cafe-text-secondary">{formatDuration(elapsed)}</span>
            {status.paused ? (
              <button
                type="button"
                onClick={onResume}
                className={`${pillButton} text-conn-emerald-text hover:bg-conn-green-text/10`}
              >
                {t.capture.resume}
              </button>
            ) : (
              <button
                type="button"
                onClick={onPause}
                className={`${pillButton} text-conn-amber-text hover:bg-[var(--console-hover-bg)]`}
              >
                {t.capture.pause}
              </button>
            )}
            <button
              type="button"
              onClick={onStop}
              className={`${pillButton} text-conn-red-text hover:bg-conn-red-text/10`}
            >
              {t.capture.stop}
            </button>
          </>
        )}
        {!status.running && hasSession && (
          <button
            type="button"
            onClick={onStartAgain}
            className="shrink-0 rounded-lg bg-cafe-text-primary px-3 py-1.5 text-xs font-medium text-cafe-surface-primary transition-opacity hover:opacity-85"
            data-testid="start-again"
          >
            {t.capture.startAgain}
          </button>
        )}
        <button
          type="button"
          onClick={onPopOut}
          className="shrink-0 rounded-lg p-1.5 text-cafe-text-muted transition-colors hover:bg-cafe-surface-secondary hover:text-cafe-text-primary"
          title={t.capture.popOut}
          aria-label={t.capture.popOut}
          data-testid="pop-out"
        >
          <PictureInPictureIcon />
        </button>
      </div>
      <AudioHealthStrip status={status} />
      {status.running && <MeetingShareControl />}
    </>
  );
}

function stoppedText(t: (typeof voiceMeetingCopy)['zh'], elapsedSec: number): string {
  if (elapsedSec >= 60) return t.capture.stoppedMinutes(Math.round(elapsedSec / 60));
  if (elapsedSec > 0) return t.capture.stoppedSeconds(Math.floor(elapsedSec));
  return t.capture.stopped;
}
