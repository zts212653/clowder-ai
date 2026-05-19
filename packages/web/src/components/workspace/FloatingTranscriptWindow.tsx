'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';

interface TranscriptLine {
  ts: number;
  elapsed_s: number;
  chunk_num: number;
  asr_latency: number;
  text: string;
  speaker_label?: string;
  speaker_confidence?: number;
  speaker_id?: string | null;
}

interface Participant {
  id: string;
  name: string;
  role?: string;
}

interface InterventionAdvisory {
  type: 'intervention_advisory';
  ts: number;
  reason: string;
  confidence: number;
  source_chunk_num: number;
  source_text: string;
  talking_point: string | null;
}

interface AudioSources {
  apps: string[];
  mics: { index: number; name: string; default: boolean }[];
}

interface FloatingTranscriptWindowProps {
  lines: TranscriptLine[];
  connected: boolean;
  recording: boolean;
  paused?: boolean;
  sourceLabel?: string;
  elapsed?: number;
  participants?: Participant[];
  savedPath?: string;
  savedRecordingPath?: string;
  sources?: AudioSources;
  onClose: () => void;
  onStop?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStart?: (source: string, appName?: string, deviceIndex?: number) => void;
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

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });
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
  savedPath,
  savedRecordingPath,
  sources,
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const [minimized, setMinimized] = useState(false);
  const [layout, setLayout] = useState<PersistedLayout>(loadLayout);
  const [correctingChunk, setCorrectingChunk] = useState<number | null>(null);
  const [selectedSource, setSelectedSource] = useState<string>('');

  useEffect(() => {
    if (autoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
  }, []);

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
          className="flex h-9 items-center gap-2 rounded-lg border-2 border-cafe-accent-primary/50 bg-cafe-surface-primary px-3 shadow-lg ring-1 ring-black/20"
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${recording ? 'bg-conn-green-text animate-pulse' : 'bg-cafe-text-muted'}`}
          />
          <span className="flex-1 truncate text-xs text-cafe-text-primary">
            {recording ? (sourceLabel ?? 'Recording') : 'Transcript'}
          </span>
          {recording && (
            <span className="font-mono text-[10px] text-cafe-text-secondary">{formatDuration(elapsed)}</span>
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
        className="flex h-full flex-col rounded-lg border-2 border-cafe-accent-primary/50 bg-cafe-surface-primary shadow-2xl ring-1 ring-black/20 backdrop-blur-md"
      >
        {/* Header — drag handle */}
        <div className="flex items-center gap-2 border-b border-cafe-border px-3 py-2 cursor-move select-none">
          <span
            className={`inline-block h-2 w-2 rounded-full ${recording ? (paused ? 'bg-amber-400' : 'bg-conn-green-text animate-pulse') : 'bg-cafe-text-muted'}`}
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
                  className="rounded px-1.5 py-0.5 text-xs text-green-400 hover:bg-conn-green-text/10"
                >
                  Resume
                </button>
              ) : onPause ? (
                <button
                  type="button"
                  onClick={onPause}
                  className="rounded px-1.5 py-0.5 text-xs text-amber-400 hover:bg-amber-500/10"
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
              className={`rounded px-1.5 py-0.5 text-xs ${advisoryMode === 'active' ? 'bg-amber-500/20 text-amber-400' : 'text-cafe-text-muted hover:text-cafe-text-primary'}`}
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

        {/* Advisory hint */}
        {advisory && (
          <div
            className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5"
            style={{ opacity: Math.max(0.5, Math.min(1, advisory.confidence)) }}
          >
            <span className="text-xs">
              {advisory.reason === 'question_detected' && '\u{1F3AF}'}
              {advisory.reason === 'extended_silence' && '\u{23F8}'}
              {advisory.reason === 'keyword_match' && '\u{1F511}'}
            </span>
            <span className="flex-1 truncate text-xs text-amber-300">
              {advisory.reason === 'question_detected' && 'Question detected'}
              {advisory.reason === 'extended_silence' && 'Pause in conversation'}
              {advisory.reason === 'keyword_match' && 'Topic match'}
              {advisory.talking_point && (
                <span className="ml-1 text-amber-200/80">&mdash; {advisory.talking_point}</span>
              )}
            </span>
            <button
              type="button"
              onClick={onAdvisoryDnd}
              className="shrink-0 text-[10px] text-amber-400/60 hover:text-amber-300"
              title="Don't disturb for 15 min"
            >
              DND
            </button>
            <button
              type="button"
              onClick={onAdvisoryDismiss}
              className="shrink-0 text-xs text-amber-400/60 hover:text-amber-300"
            >
              &times;
            </button>
          </div>
        )}

        {/* Saved paths */}
        {!recording && (savedPath || savedRecordingPath) && (
          <div className="border-b border-cafe-border bg-cafe-surface-secondary px-3 py-1.5 text-xs text-cafe-text-secondary space-y-0.5">
            {savedPath && <div>Transcript: {savedPath}</div>}
            {savedRecordingPath && <div>Recording: {savedRecordingPath}</div>}
          </div>
        )}

        {/* Source selector — shown when not recording */}
        {!recording && sources && onStart && (
          <div className="border-b border-cafe-border bg-cafe-surface-secondary px-3 py-2 space-y-2">
            <select
              value={selectedSource}
              onChange={(e) => setSelectedSource(e.target.value)}
              className="w-full rounded border border-cafe-border bg-cafe-surface-primary px-2 py-1 text-xs text-cafe-text-primary"
            >
              <option value="">Select source...</option>
              {sources.apps.map((app) => (
                <option key={app} value={`app:${app}`}>
                  {app}
                </option>
              ))}
              {sources.mics.map((mic) => (
                <option key={`mic-${mic.index}`} value={`mic:${mic.index}`}>
                  {mic.name}
                  {mic.default ? ' (default)' : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectedSource}
              onClick={() => {
                if (!selectedSource) return;
                const colonIdx = selectedSource.indexOf(':');
                const type = selectedSource.slice(0, colonIdx);
                const value = selectedSource.slice(colonIdx + 1);
                if (type === 'app') onStart('app', value);
                else onStart('mic', undefined, Number(value));
              }}
              className="w-full rounded bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-conn-green-text disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Start
            </button>
          </div>
        )}

        {/* Transcript body */}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
          {lines.length === 0 && (
            <p className="mt-8 text-center text-cafe-text-muted">
              {recording ? 'Waiting for first transcript chunk...' : 'No transcript data.'}
            </p>
          )}
          {lines.map((l, i) => (
            <div key={l.chunk_num ?? i} className="mb-1 flex gap-2">
              <span className="shrink-0 text-cafe-text-muted">[{formatTime(l.ts)}]</span>
              {l.speaker_label && (
                <span className="relative shrink-0">
                  <button
                    type="button"
                    className="font-medium text-cafe-accent-primary hover:underline"
                    onClick={() =>
                      participants?.length && onCorrect
                        ? setCorrectingChunk(correctingChunk === l.chunk_num ? null : l.chunk_num)
                        : undefined
                    }
                    title={participants?.length ? 'Click to correct speaker' : undefined}
                  >
                    {l.speaker_label}:
                  </button>
                  {correctingChunk === l.chunk_num && participants && onCorrect && (
                    <div className="absolute left-0 top-full z-10 mt-1 rounded border border-cafe-border bg-cafe-surface-primary py-1 shadow-lg">
                      {participants.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="block w-full whitespace-nowrap px-3 py-1 text-left text-xs text-cafe-text-primary hover:bg-cafe-surface-secondary"
                          onClick={() => {
                            onCorrect(l.chunk_num, p.id, p.name);
                            setCorrectingChunk(null);
                          }}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                </span>
              )}
              <span className="text-cafe-text-primary">{l.text}</span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-cafe-border px-3 py-1.5 text-[10px] text-cafe-text-muted">
          <span>{lines.length} chunks</span>
          <span>avg {avgLatency}s</span>
          <span className={connected ? 'text-green-500' : 'text-conn-red-text'}>
            {connected ? 'SSE' : 'disconnected'}
          </span>
        </div>
      </div>
    </Rnd>
  );
}
