'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import type { AudioPanelError } from './audio-panel-error';
import type {
  AudioInputRequest,
  AudioSources,
  AudioSseEvent,
  AudioStatus,
  TranscriptLine,
} from './audio-transcript-contract';
import { FloatingTranscriptWindow } from './FloatingTranscriptWindow';
import {
  clearMeetingSessionSummary,
  retainFromStopEvent,
  useRestoreMeetingSessionSummary,
} from './meeting-session-summary';
import { revokeMeetingShareBeforeCapture } from './revokeMeetingShareBeforeCapture';

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
  const [startError, setStartError] = useState<AudioPanelError | null>(null);
  const [statusResolved, setStatusResolved] = useState(false);
  const [savedResultOwner, setSavedResultOwner] = useState<string | null>(null);
  const advisoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linesRef = useRef<TranscriptLine[]>([]);
  linesRef.current = lines;
  const elapsedRef = useRef(0);
  elapsedRef.current = elapsed;
  const presentation = useShellPresentation();
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  const currentThreadIdRef = useRef(currentThreadId);
  currentThreadIdRef.current = currentThreadId;
  // R3-P1: the active capture session's owning thread, latched from the producer's contract (same rule as the docked panel).
  const captureThreadRef = useRef<string | null>(null);
  // R5: every new-capture transition bumps this epoch, invalidating the previous round's pending stop and any
  // in-flight request responses (same lifecycle rule as the docked panel).
  const sessionEpochRef = useRef(0);
  const invalidateSessionRound = useCallback(() => {
    sessionEpochRef.current += 1;
    pendingStopRef.current = null;
  }, []);
  // R4-P1b: a stop arriving before the owner is known is queued, never guessed from the current chat thread.
  const pendingStopRef = useRef<{
    event: {
      transcript_path?: string;
      recording_path?: string;
      recording_paths?: Record<string, string>;
      duration_s?: number;
    };
    lines: TranscriptLine[];
    elapsed: number;
  } | null>(null);

  const retainStoppedResult = useCallback(
    (
      event: {
        transcript_path?: string;
        recording_path?: string;
        recording_paths?: Record<string, string>;
        duration_s?: number;
      },
      eventLines: TranscriptLine[],
      eventElapsed: number,
    ) => {
      if (presentationRef.current !== 'v2') return;
      const owner = captureThreadRef.current;
      if (!owner) {
        pendingStopRef.current = { event, lines: eventLines, elapsed: eventElapsed };
        return;
      }
      retainFromStopEvent(event, eventLines, eventElapsed, owner);
      setSavedResultOwner(owner);
    },
    [],
  );

  const flushPendingStop = useCallback(() => {
    const pending = pendingStopRef.current;
    if (!pending || !captureThreadRef.current) return;
    pendingStopRef.current = null;
    retainStoppedResult(pending.event, pending.lines, pending.elapsed);
  }, [retainStoppedResult]);

  // Same restore rule as the docked panel (review P1-2), with the R2 fences: v2 lifecycle only, after the current
  // status was read, and only into the owning thread.
  useRestoreMeetingSessionSummary(
    !visible ||
      status.running ||
      Boolean(savedPath || savedRecordingPath || Object.keys(savedRecordingPaths).length > 0),
    { setSavedPath, setSavedRecordingPath, setSavedRecordingPaths, setElapsed, setLines, setSavedResultOwner },
    { enabled: visible && presentation === 'v2', statusResolved, currentThreadId },
  );

  useEffect(() => {
    if (!visible) return;
    const fetchCritical = async () => {
      const epoch = sessionEpochRef.current;
      try {
        const [statusResp, transcriptResp] = await Promise.all([
          apiFetch('/api/audio/status'),
          apiFetch('/api/audio/transcript'),
        ]);
        const statusData = statusResp.ok
          ? ((await statusResp.json()) as AudioStatus & { advisory_mode?: string })
          : null;
        const transcriptData = transcriptResp.ok
          ? ((await transcriptResp.json()) as { lines: TranscriptLine[] })
          : null;
        // R6: epoch is judged after the last await — a body completing in the next round writes nothing.
        if (sessionEpochRef.current !== epoch) return;
        if (statusData) {
          setStatus(statusData);
          if (statusData.running && statusData.duration_s) setElapsed(statusData.duration_s);
          if (statusData.thread_id) {
            captureThreadRef.current = statusData.thread_id;
            flushPendingStop();
          }
          if (statusData.advisory_mode === 'active' || statusData.advisory_mode === 'passive') {
            setAdvisoryMode(statusData.advisory_mode);
          }
          setStatusResolved(true);
        }
        if (transcriptData) {
          setLines(transcriptData.lines ?? []);
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
            invalidateSessionRound();
            clearMeetingSessionSummary();
            captureThreadRef.current = data.thread_id ?? currentThreadIdRef.current;
            setSavedResultOwner(null);
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
            retainStoppedResult(data, linesRef.current, elapsedRef.current);
          } else if (data.status === 'paused') {
            setStatus((prev) => ({ ...prev, paused: true }));
          } else if (data.status === 'resumed') {
            setStatus((prev) => ({ ...prev, paused: false }));
          }
        } else if (data.type === 'input_status') {
          // R6: the refresh joins the same epoch rule — a response completing in the next round writes nothing.
          const epoch = sessionEpochRef.current;
          void apiFetch('/api/audio/status')
            .then(async (response) => {
              if (!response.ok) return;
              const next = (await response.json()) as AudioStatus;
              if (sessionEpochRef.current !== epoch) return;
              setStatus(next);
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
    const epoch = sessionEpochRef.current;
    try {
      await revokeMeetingShareBeforeCapture();
      // R6 (same rule as the docked panel): the revoke wait can span a full stop+start elsewhere — never
      // send the old round's control POST, and never write a body that completes in the next round.
      if (sessionEpochRef.current !== epoch) return;
      const resp = await apiFetch('/api/audio/stop', { method: 'POST' });
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        summary?: {
          transcript_path?: string;
          recording_path?: string;
          recording_paths?: Record<string, string>;
        };
      };
      if (sessionEpochRef.current !== epoch) return;
      setStatus((prev) => ({ ...prev, running: false }));
      setSavedPath(data.summary?.transcript_path ?? null);
      setSavedRecordingPath(data.summary?.recording_path ?? null);
      setSavedRecordingPaths(data.summary?.recording_paths ?? {});
      if (data.summary) {
        retainStoppedResult(data.summary, linesRef.current, elapsedRef.current);
      }
    } catch {}
  }, []);

  const handlePause = useCallback(async () => {
    try {
      await revokeMeetingShareBeforeCapture();
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
        setStartError({ kind: 'open-thread-first' });
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
          invalidateSessionRound();
          clearMeetingSessionSummary();
          captureThreadRef.current = data.status.thread_id ?? currentThreadId;
          setSavedResultOwner(null);
          setStatus(data.status);
          setLines([]);
          setElapsed(0);
          setSavedPath(null);
          setSavedRecordingPath(null);
          setSavedRecordingPaths({});
        } else {
          const data = (await resp.json()) as { error?: string };
          setStartError({ kind: 'start-failed', reason: data.error });
        }
      } catch {
        setStartError({ kind: 'service-offline' });
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
      savedResultOwner={savedResultOwner}
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
