'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import { FloatingTranscriptWindow } from './FloatingTranscriptWindow';

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
  participants?: Participant[];
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
  speaker_label?: string;
  speaker_confidence?: number;
  speaker_id?: string | null;
  reason?: string;
  confidence?: number;
  source_chunk_num?: number;
  source_text?: string;
  talking_point?: string | null;
  transcript_path?: string;
  recording_path?: string;
}

export function FloatingTranscriptContainer() {
  const visible = useChatStore((s) => s.floatingTranscriptVisible);
  const setVisible = useChatStore((s) => s.setFloatingTranscriptVisible);
  const currentThreadId = useChatStore((s) => s.currentThreadId);

  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [status, setStatus] = useState<AudioStatus>({ running: false });
  const [connected, setConnected] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [advisory, setAdvisory] = useState<InterventionAdvisory | null>(null);
  const [advisoryMode, setAdvisoryMode] = useState<'active' | 'passive'>('passive');
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [savedRecordingPath, setSavedRecordingPath] = useState<string | null>(null);
  const [sources, setSources] = useState<AudioSources | null>(null);
  const advisoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) return;
    const fetchCritical = async () => {
      try {
        const [statusResp, transcriptResp] = await Promise.all([
          apiFetch('/api/audio/status'),
          apiFetch('/api/audio/transcript'),
        ]);
        if (statusResp.ok) {
          const data = (await statusResp.json()) as AudioStatus & { advisory_mode?: string };
          setStatus(data);
          if (data.running && data.duration_s) setElapsed(data.duration_s);
          if (data.advisory_mode === 'active' || data.advisory_mode === 'passive') {
            setAdvisoryMode(data.advisory_mode);
          }
        }
        if (transcriptResp.ok) {
          const data = (await transcriptResp.json()) as { lines: TranscriptLine[] };
          setLines(data.lines ?? []);
        }
      } catch {}
    };
    const fetchSources = async () => {
      try {
        const resp = await apiFetch('/api/audio/sources');
        if (resp.ok) {
          const data = (await resp.json()) as AudioSources;
          setSources(data);
        }
      } catch {}
    };
    fetchCritical();
    fetchSources();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
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
              speaker_label: data.speaker_label,
              speaker_confidence: data.speaker_confidence,
              speaker_id: data.speaker_id,
            },
          ]);
        } else if (data.type === 'intervention_advisory') {
          setAdvisory({
            type: 'intervention_advisory',
            ts: data.ts!,
            reason: data.reason!,
            confidence: data.confidence!,
            source_chunk_num: data.source_chunk_num!,
            source_text: data.source_text!,
            talking_point: data.talking_point ?? null,
          });
          if (advisoryTimer.current) clearTimeout(advisoryTimer.current);
          advisoryTimer.current = setTimeout(() => setAdvisory(null), 10_000);
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
      } catch {}
    };
    return () => es.close();
  }, [visible]);

  useEffect(() => {
    if (!visible || !status.running || status.paused) return;
    const iv = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(iv);
  }, [visible, status.running, status.paused]);

  const handleStop = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/audio/stop', { method: 'POST' });
      if (resp.ok) {
        const data = (await resp.json()) as { summary?: { transcript_path?: string; recording_path?: string } };
        setStatus((prev) => ({ ...prev, running: false }));
        setSavedPath(data.summary?.transcript_path ?? null);
        setSavedRecordingPath(data.summary?.recording_path ?? null);
      }
    } catch {}
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

  const handleCorrect = useCallback(async (chunkNum: number, speakerId: string, speakerLabel: string) => {
    try {
      const resp = await apiFetch('/api/audio/transcript/correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunk_num: chunkNum, speaker_id: speakerId, speaker_label: speakerLabel }),
      });
      if (!resp.ok) return;
      setLines((prev) =>
        prev.map((l) =>
          l.chunk_num === chunkNum
            ? { ...l, speaker_label: speakerLabel, speaker_confidence: 1.0, speaker_id: speakerId }
            : l,
        ),
      );
    } catch {}
  }, []);

  const handleToggleAdvisory = useCallback(async () => {
    const next = advisoryMode === 'active' ? 'passive' : 'active';
    try {
      const resp = await apiFetch('/api/audio/advisory-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      if (resp.ok) {
        setAdvisoryMode(next);
        if (next === 'passive') setAdvisory(null);
      }
    } catch {}
  }, [advisoryMode]);

  const handleAdvisoryDismiss = useCallback(() => {
    setAdvisory(null);
  }, []);

  const handleAdvisoryDnd = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/audio/advisory-dnd', { method: 'POST' });
      if (resp.ok) setAdvisory(null);
    } catch {}
  }, []);

  const handleClose = useCallback(() => setVisible(false), [setVisible]);

  if (!visible) return null;

  const sourceLabel = status.app_name ? status.app_name : status.source === 'mic' ? 'Microphone' : undefined;

  return createPortal(
    <FloatingTranscriptWindow
      lines={lines}
      connected={connected}
      recording={status.running}
      paused={status.paused}
      sourceLabel={sourceLabel}
      elapsed={elapsed}
      participants={status.participants}
      savedPath={savedPath ?? undefined}
      savedRecordingPath={savedRecordingPath ?? undefined}
      sources={sources ?? undefined}
      onClose={handleClose}
      onStop={handleStop}
      onPause={handlePause}
      onResume={handleResume}
      onStart={handleStart}
      onCorrect={handleCorrect}
      advisory={advisory}
      advisoryMode={advisoryMode}
      onToggleAdvisory={handleToggleAdvisory}
      onAdvisoryDismiss={handleAdvisoryDismiss}
      onAdvisoryDnd={handleAdvisoryDnd}
    />,
    document.body,
  );
}
