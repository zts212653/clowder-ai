'use client';

import { useCallback, useState } from 'react';
import { Rnd } from 'react-rnd';
import { AudioHealthStrip } from './AudioHealthStrip';
import { AudioInputPicker } from './AudioInputPicker';
import type {
  AudioInputRequest,
  AudioSources,
  AudioStatus,
  Participant,
  TranscriptLine,
} from './audio-transcript-contract';
import { FloatingTranscriptLines } from './FloatingTranscriptLines';

interface InterventionAdvisory {
  type: 'intervention_advisory';
  ts: number;
  reason: string;
  confidence: number;
  source_chunk_num: number;
  source_text: string;
  talking_point: string | null;
}

interface FloatingTranscriptWindowProps {
  lines: TranscriptLine[];
  connected: boolean;
  recording: boolean;
  paused?: boolean;
  sourceLabel?: string;
  elapsed?: number;
  participants?: Participant[];
  status?: AudioStatus;
  savedPath?: string;
  savedRecordingPath?: string;
  savedRecordingPaths?: Record<string, string>;
  sources?: AudioSources;
  startError?: string;
  onClose: () => void;
  onStop?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStart?: (inputs: AudioInputRequest[]) => void;
  onMinimize?: () => void;
  onCorrect?: (chunkNum: number, speakerId: string, speakerLabel: string) => void;
  advisory?: InterventionAdvisory | null;
  advisoryMode?: 'active' | 'passive';
  onToggleAdvisory?: () => void;
  onAdvisoryDismiss?: () => void;
  onAdvisoryDnd?: () => void;
}

const STORAGE_KEY = 'cat-cafe-floating-transcript';

interface PersistedLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

function loadLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PersistedLayout;
  } catch {}
  return { x: 100, y: 100, width: 380, height: 420 };
}

function saveLayout(layout: PersistedLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {}
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function FloatingTranscriptWindow({
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
  sources,
  startError,
  onClose,
  onStop,
  onPause,
  onResume,
  onStart,
  onMinimize,
  onCorrect,
  advisory,
  advisoryMode = 'passive',
  onToggleAdvisory,
  onAdvisoryDismiss,
  onAdvisoryDnd,
}: FloatingTranscriptWindowProps) {
  const [minimized, setMinimized] = useState(false);
  const [layout, setLayout] = useState<PersistedLayout>(loadLayout);

  const handleMinimize = useCallback(() => {
    setMinimized((v) => !v);
    onMinimize?.();
  }, [onMinimize]);

  const avgLatency = lines.length ? (lines.reduce((s, l) => s + l.asr_latency, 0) / lines.length).toFixed(2) : '—';

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
        onDragStop={(_e, d) => {
          const next = { ...layout, x: d.x, y: d.y };
          setLayout(next);
          saveLayout(next);
        }}
      >
        <div
          tabIndex={-1}
          className="flex h-9 items-center gap-2 rounded-lg border-2 border-cafe-accent-primary/50 bg-cafe-surface-primary px-3 shadow-lg ring-1 ring-[var(--console-border-soft)]"
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${recording ? 'bg-conn-green-text animate-pulse' : 'bg-cafe-text-muted'}`}
          />
          <span className="flex-1 truncate text-xs text-cafe-text-primary">
            {recording ? (sourceLabel ?? 'Recording') : 'Transcript'}
          </span>
          {recording && (
            <span className="font-mono text-micro text-cafe-text-secondary">{formatDuration(elapsed)}</span>
          )}
          <button
            type="button"
            onClick={handleMinimize}
            className="text-xs text-cafe-text-muted hover:text-cafe-text-primary"
            title="Restore"
          >
            &#9723;
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-cafe-text-muted hover:text-cafe-text-primary"
            title="Close"
          >
            &times;
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
      onDragStop={(_e, d) => {
        const next = { ...layout, x: d.x, y: d.y };
        setLayout(next);
        saveLayout(next);
      }}
      onResizeStop={(_e, _dir, ref, _delta, pos) => {
        const next = { x: pos.x, y: pos.y, width: ref.offsetWidth, height: ref.offsetHeight };
        setLayout(next);
        saveLayout(next);
      }}
    >
      <div
        tabIndex={-1}
        className="flex h-full flex-col rounded-lg border-2 border-cafe-accent-primary/50 bg-cafe-surface-primary shadow-2xl ring-1 ring-[var(--console-border-soft)] backdrop-blur-md"
      >
        {/* Header — drag handle */}
        <div className="flex items-center gap-2 border-b border-cafe-border px-3 py-2 cursor-move select-none">
          <span
            className={`inline-block h-2 w-2 rounded-full ${recording ? (paused ? 'bg-[var(--semantic-warning)]' : 'bg-conn-green-text animate-pulse') : 'bg-cafe-text-muted'}`}
          />
          <span className="flex-1 truncate text-sm font-medium text-cafe-text-primary">
            {recording ? (paused ? 'Paused' : (sourceLabel ?? 'Recording')) : 'Transcript'}
          </span>
          {recording && (
            <>
              <span className="font-mono text-xs text-cafe-text-secondary">{formatDuration(elapsed)}</span>
              {paused && onResume ? (
                <button
                  type="button"
                  onClick={onResume}
                  className="rounded px-1.5 py-0.5 text-xs text-conn-emerald-text hover:bg-conn-green-text/10"
                >
                  Resume
                </button>
              ) : onPause ? (
                <button
                  type="button"
                  onClick={onPause}
                  className="rounded px-1.5 py-0.5 text-xs text-conn-amber-text hover:bg-[var(--console-hover-bg)]"
                >
                  Pause
                </button>
              ) : null}
              {onStop && (
                <button
                  type="button"
                  onClick={onStop}
                  className="rounded px-1.5 py-0.5 text-xs text-conn-red-text hover:bg-conn-red-text/10"
                >
                  Stop
                </button>
              )}
            </>
          )}
          {onToggleAdvisory && (
            <button
              type="button"
              onClick={onToggleAdvisory}
              className={`rounded px-1.5 py-0.5 text-xs ${advisoryMode === 'active' ? 'bg-[var(--semantic-warning-surface)] text-conn-amber-text' : 'text-cafe-text-muted hover:text-cafe-text-primary'}`}
              title={advisoryMode === 'active' ? 'Advisory: ON (click to disable)' : 'Advisory: OFF (click to enable)'}
            >
              {advisoryMode === 'active' ? 'Advisory' : 'Passive'}
            </button>
          )}
          <button
            type="button"
            onClick={handleMinimize}
            className="rounded px-1 py-0.5 text-xs text-cafe-text-muted hover:text-cafe-text-primary"
            title="Minimize"
          >
            Minimize
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1 py-0.5 text-xs text-cafe-text-muted hover:text-cafe-text-primary"
            title="Close"
          >
            &times;
          </button>
        </div>

        {status && <AudioHealthStrip status={status} />}

        {/* Advisory hint */}
        {advisory && (
          <div
            className="flex items-center gap-2 border-b border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] px-3 py-1.5"
            style={{ opacity: Math.max(0.5, Math.min(1, advisory.confidence)) }}
          >
            <span className="text-xs">
              {advisory.reason === 'question_detected' && '\u{1F3AF}'}
              {advisory.reason === 'extended_silence' && '\u{23F8}'}
              {advisory.reason === 'keyword_match' && '\u{1F511}'}
            </span>
            <span className="flex-1 truncate text-xs text-conn-amber-text">
              {advisory.reason === 'question_detected' && 'Question detected'}
              {advisory.reason === 'extended_silence' && 'Pause in conversation'}
              {advisory.reason === 'keyword_match' && 'Topic match'}
              {advisory.talking_point && (
                <span className="ml-1 text-conn-amber-text/80">&mdash; {advisory.talking_point}</span>
              )}
            </span>
            <button
              type="button"
              onClick={onAdvisoryDnd}
              className="shrink-0 text-micro text-conn-amber-text/60 hover:text-conn-amber-text"
              title="Don't disturb for 15 min"
            >
              DND
            </button>
            <button
              type="button"
              onClick={onAdvisoryDismiss}
              className="shrink-0 text-xs text-conn-amber-text/60 hover:text-conn-amber-text"
            >
              &times;
            </button>
          </div>
        )}

        {/* Saved paths */}
        {!recording && (savedPath || savedRecordingPath || Object.keys(savedRecordingPaths).length > 0) && (
          <div className="border-b border-cafe-border bg-cafe-surface-secondary px-3 py-1.5 text-xs text-cafe-text-secondary space-y-0.5">
            {savedPath && <div>Transcript: {savedPath}</div>}
            {savedRecordingPath && <div>Recording: {savedRecordingPath}</div>}
            {!savedRecordingPath &&
              Object.entries(savedRecordingPaths).map(([inputId, path]) => (
                <div key={inputId}>
                  Recording ({inputId}): {path}
                </div>
              ))}
          </div>
        )}

        {/* Source selector — shown when not recording */}
        {!recording && sources && onStart && (
          <div className="border-b border-cafe-border bg-cafe-surface-secondary px-3 py-2 space-y-2">
            <AudioInputPicker sources={sources} onStart={onStart} />
            {startError && <p className="text-xs text-conn-red-text">{startError}</p>}
          </div>
        )}

        <FloatingTranscriptLines
          lines={lines}
          recording={recording}
          participants={participants}
          onCorrect={onCorrect}
        />

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-cafe-border px-3 py-1.5 text-micro text-cafe-text-muted">
          <span>{lines.length} chunks</span>
          <span>avg {avgLatency}s</span>
          <span className={connected ? 'text-conn-emerald-text' : 'text-conn-red-text'}>
            {connected ? 'SSE' : 'disconnected'}
          </span>
        </div>
      </div>
    </Rnd>
  );
}
