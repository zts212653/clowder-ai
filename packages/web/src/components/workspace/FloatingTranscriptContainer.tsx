'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import type {
  AudioInputRequest,
  AudioSources,
  AudioSseEvent,
  AudioStatus,
  TranscriptLine,
} from './audio-transcript-contract';
import { FloatingTranscriptWindow } from './FloatingTranscriptWindow';

interface InterventionAdvisory {
  type: 'intervention_advisory';
  ts: number;
  reason: string;
  confidence: number;
  source_chunk_num: number;
  source_text: string;
  talking_point: string | null;
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
  const [savedRecordingPaths, setSavedRecordingPaths] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<AudioSources | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
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
        } else if (
          data.type === 'intervention_advisory' &&
          typeof data.ts === 'number' &&
          typeof data.reason === 'string' &&
          typeof data.confidence === 'number' &&
          typeof data.source_chunk_num === 'number' &&
          typeof data.source_text === 'string'
        ) {
          setAdvisory({
            type: 'intervention_advisory',
            ts: data.ts,
            reason: data.reason,
            confidence: data.confidence,
            source_chunk_num: data.source_chunk_num,
            source_text: data.source_text,
            talking_point: data.talking_point ?? null,
          });
          if (advisoryTimer.current) clearTimeout(advisoryTimer.current);
          advisoryTimer.current = setTimeout(() => setAdvisory(null), 10_000);
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
          void apiFetch('/api/audio/status')
            .then(async (response) => {
              if (response.ok) setStatus((await response.json()) as AudioStatus);
            })
            .catch(() => undefined);
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

  const sourceLabel = status.inputs?.length
    ? status.inputs.map((input) => input.label ?? input.id).join(' + ')
    : status.app_name
      ? status.app_name
      : status.source === 'mic'
        ? 'Microphone'
        : undefined;

  return createPortal(
    <FloatingTranscriptWindow
      lines={lines}
      connected={connected}
      recording={status.running}
      paused={status.paused}
      sourceLabel={sourceLabel}
      elapsed={elapsed}
      participants={status.participants}
      status={status}
      savedPath={savedPath ?? undefined}
      savedRecordingPath={savedRecordingPath ?? undefined}
      savedRecordingPaths={savedRecordingPaths}
      sources={sources ?? undefined}
      startError={startError ?? undefined}
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
