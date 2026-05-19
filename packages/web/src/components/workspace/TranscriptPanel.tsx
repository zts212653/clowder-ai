'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';

interface TranscriptLine {
  ts: number;
  elapsed_s: number;
  chunk_num: number;
  asr_latency: number;
  text: string;
}

interface AudioSources {
  apps: string[];
  mics: { index: number; name: string; default: boolean }[];
}

interface AudioStatus {
  running: boolean;
  paused?: boolean;
  source?: string;
  app_name?: string;
  duration_s?: number;
  chunk_count?: number;
  avg_asr_latency?: number;
}

interface SseEvent {
  type: string;
  status?: string;
  source?: string;
  app_name?: string;
  ts?: number;
  elapsed_s?: number;
  chunk_num?: number;
  asr_latency?: number;
  text?: string;
  transcript_path?: string;
  recording_path?: string;
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });
}

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
  const [sources, setSources] = useState<AudioSources | null>(null);
  const [selectedSource, setSelectedSource] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const setRightPanelMode = useChatStore((s) => s.setRightPanelMode);
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
      }
    } catch {}
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
        const data = JSON.parse(ev.data) as SseEvent;
        if (data.type === 'transcript' && data.ts && data.text != null) {
          setLines((prev) => [
            ...prev,
            {
              ts: data.ts!,
              elapsed_s: data.elapsed_s ?? 0,
              chunk_num: data.chunk_num ?? 0,
              asr_latency: data.asr_latency ?? 0,
              text: data.text!,
            },
          ]);
        } else if (data.type === 'status') {
          if (data.status === 'started') {
            setStatus({ running: true, source: data.source, app_name: data.app_name });
            setLines([]);
            setElapsed(0);
            setSavedPath(null);
            setSavedRecordingPath(null);
          } else if (data.status === 'stopped') {
            setStatus((prev) => ({ ...prev, running: false, paused: false }));
            if (data.transcript_path) setSavedPath(data.transcript_path);
            if (data.recording_path) setSavedRecordingPath(data.recording_path);
          } else if (data.status === 'paused') {
            setStatus((prev) => ({ ...prev, paused: true }));
          } else if (data.status === 'resumed') {
            setStatus((prev) => ({ ...prev, paused: false }));
          }
        }
      } catch {
        /* parse error */
      }
    };
    return () => es.close();
  }, []);

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
        const data = (await resp.json()) as { summary?: { transcript_path?: string; recording_path?: string } };
        setStatus((prev) => ({ ...prev, running: false }));
        setSavedPath(data.summary?.transcript_path ?? null);
        setSavedRecordingPath(data.summary?.recording_path ?? null);
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
    async (source: string, appName?: string, deviceIndex?: number) => {
      try {
        const body: Record<string, unknown> = { source };
        if (appName) body.app_name = appName;
        if (deviceIndex != null) body.device = deviceIndex;
        if (currentThreadId) body.thread_id = currentThreadId;
        const resp = await apiFetch('/api/audio/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (resp.ok) {
          setStatus({ running: true, source, app_name: appName });
          setLines([]);
          setElapsed(0);
          setSavedPath(null);
          setSavedRecordingPath(null);
        }
      } catch {}
    },
    [currentThreadId],
  );

  const avgLatency = lines.length ? (lines.reduce((s, l) => s + l.asr_latency, 0) / lines.length).toFixed(2) : '—';
  const sourceLabel = status.app_name ? `${status.app_name}` : status.source === 'mic' ? 'Microphone' : '—';

  return (
    <div className="flex h-full flex-col border-l border-cafe-border bg-cafe-surface-primary">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-cafe-border px-3 py-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${status.running ? (status.paused ? 'bg-amber-400' : 'bg-conn-green-text animate-pulse') : 'bg-cafe-text-muted'}`}
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
                className="rounded px-1.5 py-0.5 text-xs text-green-400 hover:bg-conn-green-text/10"
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={handlePause}
                className="rounded px-1.5 py-0.5 text-xs text-amber-400 hover:bg-amber-500/10"
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
        <button
          type="button"
          onClick={() => setRightPanelMode('status')}
          className="rounded px-1 py-0.5 text-xs text-cafe-text-muted hover:text-cafe-text-primary"
          title="Close transcript panel"
        >
          &times;
        </button>
      </div>

      {/* Source selector — shown when not recording */}
      {!status.running && sources && (
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
              if (type === 'app') handleStart('app', value);
              else handleStart('mic', undefined, Number(value));
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
            {status.running
              ? 'Waiting for first transcript chunk...'
              : 'No transcript data. Start audio capture to begin.'}
          </p>
        )}
        {lines.map((l, i) => (
          <div key={l.chunk_num ?? i} className="mb-1 flex gap-2">
            <span className="shrink-0 text-cafe-text-muted">[{formatTime(l.ts)}]</span>
            <span className="text-cafe-text-primary">{l.text}</span>
          </div>
        ))}
      </div>

      {/* Saved paths */}
      {!status.running && (savedPath || savedRecordingPath) && (
        <div className="border-t border-cafe-border px-3 py-1.5 text-xs text-cafe-text-secondary space-y-0.5">
          {savedPath && <div>Transcript: {savedPath}</div>}
          {savedRecordingPath && <div>Recording: {savedRecordingPath}</div>}
        </div>
      )}

      {/* Footer stats */}
      <div className="flex items-center gap-3 border-t border-cafe-border px-3 py-1.5 text-[10px] text-cafe-text-muted">
        <span>{lines.length} chunks</span>
        <span>avg {avgLatency}s</span>
        <span>16kHz mono</span>
        <span className={connected ? 'text-green-500' : 'text-conn-red-text'}>
          {connected ? 'SSE' : 'disconnected'}
        </span>
      </div>
    </div>
  );
}
