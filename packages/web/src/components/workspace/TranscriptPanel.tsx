'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import { AudioHealthStrip } from './AudioHealthStrip';
import { AudioInputPicker } from './AudioInputPicker';
import type {
  AudioInputRequest,
  AudioSources,
  AudioSseEvent,
  AudioStatus,
  TranscriptLine,
} from './audio-transcript-contract';
import { TranscriptLineRow } from './TranscriptLineRow';

export type { TranscriptLine } from './audio-transcript-contract';
export { TranscriptLineRow } from './TranscriptLineRow';

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function TranscriptPanel() {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [status, setStatus] = useState<AudioStatus>({ running: false });
  const [connected, setConnected] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [savedRecordingPath, setSavedRecordingPath] = useState<string | null>(null);
  const [savedRecordingPaths, setSavedRecordingPaths] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<AudioSources | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const setFloatingTranscriptVisible = useChatStore((s) => s.setFloatingTranscriptVisible);
  const currentThreadId = useChatStore((s) => s.currentThreadId);

  const fetchStatus = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/audio/status');
      if (resp.ok) {
        const data = (await resp.json()) as AudioStatus;
        setStatus(data);
        if (data.running && data.duration_s) setElapsed(data.duration_s);
      }
    } catch {
      /* offline */
    }
  }, []);

  const fetchTranscript = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/audio/transcript');
      if (resp.ok) {
        const data = (await resp.json()) as { lines: TranscriptLine[] };
        if (data.lines?.length) setLines(data.lines);
      }
    } catch {
      /* offline */
    }
  }, []);

  const fetchSources = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/audio/sources');
      if (resp.ok) {
        const data = (await resp.json()) as AudioSources;
        setSources(data);
        setSourceError(null);
      } else {
        setSourceError('Audio sources are unavailable.');
      }
    } catch {
      setSourceError('Audio service is offline.');
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchTranscript();
    fetchSources();
  }, [fetchStatus, fetchTranscript, fetchSources]);

  useEffect(() => {
    const es = new EventSource(`${API_URL}/api/audio/events`, { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as AudioSseEvent;
        if (data.type === 'transcript' && typeof data.ts === 'number' && typeof data.text === 'string') {
          const timestamp = data.ts;
          const text = data.text;
          setLines((prev) => [
            ...prev,
            {
              ts: timestamp,
              elapsed_s: data.elapsed_s ?? 0,
              chunk_num: data.chunk_num ?? 0,
              asr_latency: data.asr_latency ?? 0,
              text,
              speaker_label: data.speaker_label,
              speaker_confidence: data.speaker_confidence,
              speaker_id: data.speaker_id,
              speaker_identity_source: data.speaker_identity_source,
              speaker_cluster_id: data.speaker_cluster_id,
              input_id: data.input_id,
              input_source: data.input_source,
              input_label: data.input_label,
            },
          ]);
        } else if (data.type === 'status') {
          if (data.status === 'started') {
            setStatus((previous) => ({
              ...previous,
              running: true,
              source: data.source,
              app_name: data.app_name,
              inputs: data.inputs,
              health: data.health ?? previous.health,
            }));
            setLines([]);
            setElapsed(0);
            setSavedPath(null);
            setSavedRecordingPath(null);
            setSavedRecordingPaths({});
          } else if (data.status === 'stopped') {
            setStatus((prev) => ({ ...prev, running: false, paused: false }));
            if (data.transcript_path) setSavedPath(data.transcript_path);
            if (data.recording_path) setSavedRecordingPath(data.recording_path);
            setSavedRecordingPaths(data.recording_paths ?? {});
          } else if (data.status === 'paused') {
            setStatus((prev) => ({ ...prev, paused: true }));
          } else if (data.status === 'resumed') {
            setStatus((prev) => ({ ...prev, paused: false }));
          }
        } else if (data.type === 'input_status') {
          void fetchStatus();
        }
      } catch {
        /* parse error */
      }
    };
    return () => es.close();
  }, [fetchStatus]);

  useEffect(() => {
    if (!status.running || status.paused) return;
    const iv = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(iv);
  }, [status.running, status.paused]);

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

  const handleStop = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/audio/stop', { method: 'POST' });
      if (resp.ok) {
        const data = (await resp.json()) as {
          summary?: {
            transcript_path?: string;
            recording_path?: string;
            recording_paths?: Record<string, string>;
          };
        };
        setStatus((prev) => ({ ...prev, running: false }));
        setSavedPath(data.summary?.transcript_path ?? null);
        setSavedRecordingPath(data.summary?.recording_path ?? null);
        setSavedRecordingPaths(data.summary?.recording_paths ?? {});
      }
    } catch {
      /* offline */
    }
  }, []);

  const handlePause = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/audio/pause', { method: 'POST' });
      if (resp.ok) setStatus((prev) => ({ ...prev, paused: true }));
    } catch {}
  }, []);

  const handleResume = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/audio/resume', { method: 'POST' });
      if (resp.ok) setStatus((prev) => ({ ...prev, paused: false }));
    } catch {}
  }, []);

  const handleStart = useCallback(
    async (inputs: AudioInputRequest[]) => {
      if (!currentThreadId) {
        setStartError('Open a thread before starting companion audio.');
        return;
      }
      try {
        setStartError(null);
        const resp = await apiFetch('/api/audio/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs, thread_id: currentThreadId }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { status: AudioStatus };
          setStatus(data.status);
          setLines([]);
          setElapsed(0);
          setSavedPath(null);
          setSavedRecordingPath(null);
          setSavedRecordingPaths({});
        } else {
          const data = (await resp.json()) as { error?: string };
          setStartError(data.error ?? 'Audio capture could not start.');
        }
      } catch {
        setStartError('Audio service is offline.');
      }
    },
    [currentThreadId],
  );

  const avgLatency = lines.length ? (lines.reduce((s, l) => s + l.asr_latency, 0) / lines.length).toFixed(2) : '—';
  const sourceLabel = status.inputs?.length
    ? status.inputs.map((input) => input.label ?? input.id).join(' + ')
    : status.app_name
      ? status.app_name
      : status.source === 'mic'
        ? 'Microphone'
        : '—';

  return (
    <div className="flex h-full flex-col bg-cafe-surface-primary">
      {/* Header */}
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
                onClick={handleResume}
                className="rounded px-1.5 py-0.5 text-xs text-conn-emerald-text hover:bg-conn-green-text/10"
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={handlePause}
                className="rounded px-1.5 py-0.5 text-xs text-conn-amber-text hover:bg-[var(--console-hover-bg)]"
              >
                Pause
              </button>
            )}
            <button
              type="button"
              onClick={handleStop}
              className="rounded px-1.5 py-0.5 text-xs text-conn-red-text hover:bg-conn-red-text/10"
            >
              Stop
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => {
            setFloatingTranscriptVisible(true);
          }}
          className="rounded px-1 py-0.5 text-xs text-cafe-text-muted hover:text-cafe-text-primary"
          title="Pop out to floating window"
        >
          &#8599;
        </button>
      </div>

      <AudioHealthStrip status={status} />

      {!status.running && (
        <div className="border-b border-cafe-border bg-cafe-surface-secondary px-3 py-2 space-y-2">
          {sourceError ? (
            <p className="text-xs text-conn-red-text">{sourceError}</p>
          ) : sources ? (
            <AudioInputPicker sources={sources} onStart={handleStart} />
          ) : (
            <p className="text-xs text-cafe-text-muted">Loading audio sources…</p>
          )}
          {startError && <p className="text-xs text-conn-red-text">{startError}</p>}
        </div>
      )}

      {/* Transcript body */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
        {lines.length === 0 && (
          <p className="mt-8 text-center text-cafe-text-muted">
            {status.running
              ? 'Waiting for first transcript chunk...'
              : 'No transcript data. Start audio capture to begin.'}
          </p>
        )}
        {lines.map((l, i) => (
          <TranscriptLineRow key={l.chunk_num ?? i} line={l} />
        ))}
      </div>

      {/* Saved paths */}
      {!status.running && (savedPath || savedRecordingPath || Object.keys(savedRecordingPaths).length > 0) && (
        <div className="border-t border-cafe-border px-3 py-1.5 text-xs text-cafe-text-secondary space-y-0.5">
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

      {/* Footer stats */}
      <div className="flex items-center gap-3 border-t border-cafe-border px-3 py-1.5 text-micro text-cafe-text-muted">
        <span>{lines.length} chunks</span>
        <span>avg {avgLatency}s</span>
        <span>16kHz mono</span>
        <span className={connected ? 'text-conn-emerald-text' : 'text-conn-red-text'}>
          {connected ? 'SSE' : 'disconnected'}
        </span>
      </div>
    </div>
  );
}
