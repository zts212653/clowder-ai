'use client';

import { useCallback, useState } from 'react';
import { Rnd } from 'react-rnd';
import { useShellCopy } from '@/components/shell/shell-copy';
import { AudioHealthStrip } from './AudioHealthStrip';
import { AudioInputPicker } from './AudioInputPicker';
import { linesAvgLatency } from './audio-panel-error';
import type { FloatingTranscriptWindowProps } from './FloatingTranscriptWindowClassic';
import {
  formatDuration,
  type InterventionAdvisory,
  loadLayout,
  type PersistedLayout,
  saveLayout,
} from './floating-transcript-layout';
import { MeetingShareControl } from './MeetingShareControl';
import { SavedPathsV2 } from './SavedPathsV2';
import { TranscriptFooterV2 } from './TranscriptFooterV2';
import { TranscriptLinesV2 } from './TranscriptLinesV2';
import { voiceMeetingCopy } from './voice-meeting.shell-copy';

const iconButton =
  'rounded-lg p-1.5 text-cafe-text-muted transition-colors hover:bg-cafe-surface-secondary hover:text-cafe-text-primary';

function ChevronDownIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m4 10 4-4 4 4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

function AdvisorySwitch({
  mode,
  onToggle,
  label,
  title,
}: {
  mode: 'active' | 'passive';
  onToggle: () => void;
  label: string;
  title: string;
}) {
  const on = mode === 'active';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      title={title}
      className="flex shrink-0 items-center gap-1.5 text-micro text-cafe-text-secondary"
      data-testid="advisory-switch"
    >
      <span>{label}</span>
      <span
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${on ? 'bg-[var(--semantic-success)]' : 'bg-cafe-text-muted/40'}`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-cafe-surface-primary shadow transition-transform ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`}
        />
      </span>
    </button>
  );
}

function AdvisoryCard({
  advisory,
  onDismiss,
  onDnd,
}: {
  advisory: InterventionAdvisory;
  onDismiss?: () => void;
  onDnd?: () => void;
}) {
  const t = useShellCopy(voiceMeetingCopy);
  const title =
    advisory.reason === 'question_detected'
      ? t.floating.questionDetected
      : advisory.reason === 'extended_silence'
        ? t.floating.pauseInConversation
        : t.floating.topicMatch;
  return (
    <div
      className="mx-3 mt-2 rounded-lg border border-[var(--semantic-warning)]/40 bg-[var(--semantic-warning-surface)] px-3 py-2"
      style={{ opacity: Math.max(0.5, Math.min(1, advisory.confidence)) }}
      data-testid="advisory-card"
    >
      <p className="text-xs font-medium text-conn-amber-text">{title}</p>
      <p className="mt-0.5 text-xs text-cafe-text-primary">
        {advisory.source_text}
        {advisory.talking_point && (
          <span className="text-cafe-text-secondary"> {t.floating.advisoryPoint(advisory.talking_point)}</span>
        )}
      </p>
      <div className="mt-1.5 flex gap-1.5">
        {onDnd && (
          <button
            type="button"
            onClick={onDnd}
            className="rounded-lg border border-cafe-border bg-cafe-surface-primary px-2 py-0.5 text-micro text-cafe-text-primary hover:bg-cafe-surface-secondary"
          >
            {t.floating.dnd}
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg border border-cafe-border bg-cafe-surface-primary px-2 py-0.5 text-micro text-cafe-text-primary hover:bg-cafe-surface-secondary"
          >
            {t.floating.dismiss}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * §1.14 语音 5 — the v2 floating window: it keeps floating over the chat while the Workspace does other things.
 * Header: status dot + title + elapsed, the 主动提醒 switch, minimize and close. Capture controls (暂停/停止) stay
 * in the docked panel — the accepted design's floating surface carries monitoring (health, advisory, correction),
 * not capture control.
 */
export function FloatingTranscriptWindowV2({
  lines,
  connected,
  recording,
  paused = false,
  sourceLabel,
  elapsed = 0,
  participants,
  status,
  savedPath,
  savedRecordingPath,
  savedRecordingPaths = {},
  savedResultOwner,
  sources,
  startError,
  onClose,
  onStart,
  onMinimize,
  onCorrect,
  advisory,
  advisoryMode = 'passive',
  onToggleAdvisory,
  onAdvisoryDismiss,
  onAdvisoryDnd,
}: FloatingTranscriptWindowProps) {
  const t = useShellCopy(voiceMeetingCopy);
  const [minimized, setMinimized] = useState(false);
  const [layout, setLayout] = useState<PersistedLayout>(loadLayout);

  const handleMinimize = useCallback(() => {
    setMinimized((v) => !v);
    onMinimize?.();
  }, [onMinimize]);

  const persistDrag = useCallback(
    (x: number, y: number) => {
      const next = { ...layout, x, y };
      setLayout(next);
      saveLayout(next);
    },
    [layout],
  );

  // Live value comes from the actual lines (review P2-5); the status snapshot only fills the no-lines gap.
  const avgLatencySeconds =
    linesAvgLatency(lines) ?? (typeof status?.avg_asr_latency === 'number' ? status.avg_asr_latency.toFixed(2) : null);

  const title = recording ? (paused ? t.capture.paused : (sourceLabel ?? t.meeting.title)) : t.meeting.title;
  const dot = recording
    ? paused
      ? 'bg-[var(--semantic-warning)]'
      : 'bg-conn-green-text animate-pulse'
    : 'bg-cafe-text-muted';

  if (minimized) {
    return (
      <Rnd
        default={{ x: layout.x, y: layout.y, width: 260, height: 36 }}
        minWidth={200}
        minHeight={36}
        maxHeight={36}
        enableResizing={false}
        bounds="window"
        tabIndex={-1}
        className="z-[9999]"
        onDragStop={(_e, d) => persistDrag(d.x, d.y)}
      >
        <div
          tabIndex={-1}
          className="flex h-9 items-center gap-2 rounded-lg border border-cafe-border bg-cafe-surface-primary px-3 shadow-lg"
        >
          <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
          <span className="flex-1 truncate text-xs text-cafe-text-primary">{title}</span>
          {recording && (
            <span className="font-mono text-micro text-cafe-text-secondary">{formatDuration(elapsed)}</span>
          )}
          <button
            type="button"
            onClick={handleMinimize}
            className={iconButton}
            title={t.floating.restore}
            aria-label={t.floating.restore}
          >
            <ChevronUpIcon />
          </button>
          <button
            type="button"
            onClick={onClose}
            className={iconButton}
            title={t.floating.close}
            aria-label={t.floating.close}
          >
            <CloseIcon />
          </button>
        </div>
      </Rnd>
    );
  }

  return (
    <Rnd
      default={{ x: layout.x, y: layout.y, width: layout.width, height: layout.height }}
      minWidth={280}
      minHeight={200}
      bounds="window"
      tabIndex={-1}
      className="z-[9999]"
      onDragStop={(_e, d) => persistDrag(d.x, d.y)}
      onResizeStop={(_e, _dir, ref, _delta, pos) => {
        const next = { x: pos.x, y: pos.y, width: ref.offsetWidth, height: ref.offsetHeight };
        setLayout(next);
        saveLayout(next);
      }}
    >
      <div
        tabIndex={-1}
        className="flex h-full flex-col rounded-lg border border-cafe-border bg-cafe-surface-primary shadow-2xl backdrop-blur-md"
      >
        {/* Header — drag handle */}
        <div className="flex items-center gap-2 border-b border-cafe-border px-3 py-2 cursor-move select-none">
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-cafe-text-primary">{title}</span>
          {recording && (
            <span className="shrink-0 font-mono text-xs text-cafe-text-secondary">{formatDuration(elapsed)}</span>
          )}
          {onToggleAdvisory && (
            <AdvisorySwitch
              mode={advisoryMode}
              onToggle={onToggleAdvisory}
              label={t.floating.advisory}
              title={advisoryMode === 'active' ? t.floating.advisoryOn : t.floating.advisoryOff}
            />
          )}
          <button
            type="button"
            onClick={handleMinimize}
            className={iconButton}
            title={t.floating.minimize}
            aria-label={t.floating.minimize}
            data-testid="floating-minimize"
          >
            <ChevronDownIcon />
          </button>
          <button
            type="button"
            onClick={onClose}
            className={iconButton}
            title={t.floating.close}
            aria-label={t.floating.close}
            data-testid="floating-close"
          >
            <CloseIcon />
          </button>
        </div>

        {status && <AudioHealthStrip status={status} />}
        {recording && <MeetingShareControl />}

        {advisory && <AdvisoryCard advisory={advisory} onDismiss={onAdvisoryDismiss} onDnd={onAdvisoryDnd} />}

        {!recording && (
          <SavedPathsV2
            savedPath={savedPath}
            savedRecordingPath={savedRecordingPath}
            savedRecordingPaths={savedRecordingPaths}
            ownerThreadId={savedResultOwner}
            inputLabels={Object.fromEntries((status?.inputs ?? []).map((input) => [input.id, input.label ?? input.id]))}
          />
        )}

        {!recording && sources && onStart && (
          <div className="border-b border-cafe-border px-3 py-2.5">
            <AudioInputPicker sources={sources} onStart={onStart} />
            {startError && (
              <p className="mt-1.5 text-xs text-conn-red-text">
                {startError.kind === 'open-thread-first'
                  ? t.capture.openThreadFirst
                  : startError.kind === 'service-offline'
                    ? t.capture.serviceOffline
                    : startError.kind === 'sources-unavailable'
                      ? t.capture.sourcesUnavailable
                      : startError.reason
                        ? t.capture.startError(startError.reason)
                        : t.capture.startFailedGeneric}
              </p>
            )}
          </div>
        )}

        <TranscriptLinesV2
          lines={lines}
          waiting={recording}
          emptyText={t.floating.empty}
          waitingText={t.floating.waiting}
          participants={participants}
          onCorrect={onCorrect}
        />

        <TranscriptFooterV2 lineCount={lines.length} avgLatencySeconds={avgLatencySeconds} connected={connected} />
      </div>
    </Rnd>
  );
}
