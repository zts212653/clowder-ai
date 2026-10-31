import { useShellPresentation } from '@/components/shell/shell-presentation';
import { AudioHealthStrip } from './AudioHealthStrip';
import type { AudioStatus } from './audio-transcript-contract';
import { MeetingShareControl } from './MeetingShareControl';
import { TranscriptCaptureHeaderV2 } from './TranscriptCaptureHeaderV2';

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export interface TranscriptCaptureHeaderProps {
  status: AudioStatus;
  sourceLabel: string;
  elapsed: number;
  onResume(): void;
  onPause(): void;
  onStop(): void;
  onPopOut(): void;
  /** v2 only: whether a stopped session still has something to show (lines, saved paths or elapsed time). */
  hasSession?: boolean;
  /** v2 only: reset the panel back to its prepare state after a stop. */
  onStartAgain?: () => void;
}

function TranscriptCaptureHeaderClassic({
  status,
  sourceLabel,
  elapsed,
  onResume,
  onPause,
  onStop,
  onPopOut,
}: TranscriptCaptureHeaderProps) {
  return (
    <>
      <div className="flex items-center gap-2 border-b border-cafe-border px-3 py-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${status.running ? (status.paused ? 'bg-[var(--semantic-warning)]' : 'bg-conn-green-text animate-pulse') : 'bg-cafe-text-muted'}`}
        />
        <span className="flex-1 truncate text-sm font-medium text-cafe-text-primary">
          {status.running ? (status.paused ? 'Paused' : sourceLabel) : 'Not monitoring'}
        </span>
        {status.running && (
          <>
            <span className="font-mono text-xs text-cafe-text-secondary">{formatDuration(elapsed)}</span>
            {status.paused ? (
              <button
                type="button"
                onClick={onResume}
                className="rounded px-1.5 py-0.5 text-xs text-conn-emerald-text hover:bg-conn-green-text/10"
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={onPause}
                className="rounded px-1.5 py-0.5 text-xs text-conn-amber-text hover:bg-[var(--console-hover-bg)]"
              >
                Pause
              </button>
            )}
            <button
              type="button"
              onClick={onStop}
              className="rounded px-1.5 py-0.5 text-xs text-conn-red-text hover:bg-conn-red-text/10"
            >
              Stop
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onPopOut}
          className="rounded px-1 py-0.5 text-xs text-cafe-text-muted hover:text-cafe-text-primary"
          title="Pop out to floating window"
        >
          &#8599;
        </button>
      </div>
      <AudioHealthStrip status={status} />
      {status.running && <MeetingShareControl />}
    </>
  );
}

export function TranscriptCaptureHeader(props: TranscriptCaptureHeaderProps) {
  const presentation = useShellPresentation();
  if (presentation !== 'v2') return <TranscriptCaptureHeaderClassic {...props} />;
  return (
    <TranscriptCaptureHeaderV2
      {...props}
      hasSession={props.hasSession ?? false}
      onStartAgain={props.onStartAgain ?? (() => {})}
    />
  );
}
