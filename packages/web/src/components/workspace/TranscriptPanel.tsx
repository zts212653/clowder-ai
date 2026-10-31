'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import { type AudioPanelError, linesAvgLatency } from './audio-panel-error';
import type {
  AudioInputRequest,
  AudioSources,
  AudioSseEvent,
  AudioStatus,
  TranscriptLine,
} from './audio-transcript-contract';
import {
  clearMeetingSessionSummary,
  retainFromStopEvent,
  useRestoreMeetingSessionSummary,
} from './meeting-session-summary';
import { revokeMeetingShareBeforeCapture } from './revokeMeetingShareBeforeCapture';
import { TranscriptPanelClassicView } from './TranscriptPanelClassicView';
import { TranscriptPanelV2 } from './TranscriptPanelV2';

export type { TranscriptLine } from './audio-transcript-contract';
export { TranscriptLineRow } from './TranscriptLineRow';

export function TranscriptPanel() {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [status, setStatus] = useState<AudioStatus>({ running: false });
  const [connected, setConnected] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [savedRecordingPath, setSavedRecordingPath] = useState<string | null>(null);
  const [savedRecordingPaths, setSavedRecordingPaths] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<AudioSources | null>(null);
  const [sourceError, setSourceError] = useState<AudioPanelError | null>(null);
  const [startError, setStartError] = useState<AudioPanelError | null>(null);
  const [statusResolved, setStatusResolved] = useState(false);
  const [savedResultOwner, setSavedResultOwner] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const linesRef = useRef<TranscriptLine[]>([]);
  linesRef.current = lines;
  const elapsedRef = useRef(0);
  elapsedRef.current = elapsed;
  const presentation = useShellPresentation();
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  const setFloatingTranscriptVisible = useChatStore((s) => s.setFloatingTranscriptVisible);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const currentThreadIdRef = useRef(currentThreadId);
  currentThreadIdRef.current = currentThreadId;
  // R3-P1: the active capture session's owning thread, latched from the producer's start/status contract.
  // Neither the first mounted chat thread (stale SSE closure) nor whichever thread is selected at stop
  // time — a capture started in A still belongs to A after switching to B mid-capture.
  const captureThreadRef = useRef<string | null>(null);
  // R5: every new-capture/reset transition bumps this epoch. A pending stop queued in the previous round and any
  // in-flight request response from the previous round are invalid the moment the epoch moves — a stale
  // status/stop snapshot can never resurrect a discarded result or overwrite a new capture's owner.
  const sessionEpochRef = useRef(0);
  const invalidateSessionRound = useCallback(() => {
    sessionEpochRef.current += 1;
    pendingStopRef.current = null;
  }, []);
  // R4-P1b: a stop that arrives before the owner is known (e.g. initial status GET still pending) is queued
  // and retained only once the producer resolves the owner — never guessed from the current chat thread.
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

  const fetchStatus = useCallback(async () => {
    const epoch = sessionEpochRef.current;
    try {
      const resp = await apiFetch('/api/audio/status');
      if (!resp.ok) return;
      const data = (await resp.json()) as AudioStatus;
      // R6: epoch is judged after the last await — HTTP headers arriving early must not let a body that
      // completes in the next round write state/owner.
      if (sessionEpochRef.current !== epoch) return;
      setStatus(data);
      if (data.running && data.duration_s) setElapsed(data.duration_s);
      // The producer reports the capture owner on every status, including a stopped one (R4-P1b).
      if (data.thread_id) {
        captureThreadRef.current = data.thread_id;
        flushPendingStop();
      }
      setStatusResolved(true);
    } catch {
      /* offline */
    }
  }, [flushPendingStop]);

  const fetchTranscript = useCallback(async () => {
    const epoch = sessionEpochRef.current;
    try {
      const resp = await apiFetch('/api/audio/transcript');
      if (!resp.ok) return;
      const data = (await resp.json()) as { lines: TranscriptLine[] };
      if (sessionEpochRef.current !== epoch) return;
      if (data.lines?.length) setLines(data.lines);
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
        setSourceError({ kind: 'sources-unavailable' });
      }
    } catch {
      setSourceError({ kind: 'service-offline' });
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchTranscript();
    fetchSources();
  }, [fetchStatus, fetchTranscript, fetchSources]);

  useRestoreMeetingSessionSummary(
    status.running || Boolean(savedPath || savedRecordingPath || Object.keys(savedRecordingPaths).length > 0),
    { setSavedPath, setSavedRecordingPath, setSavedRecordingPaths, setElapsed, setLines, setSavedResultOwner },
    // R2-1/R2-2: v2 lifecycle only, after the current status is known, same thread only.
    { enabled: presentation === 'v2', statusResolved, currentThreadId },
  );

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
            // Retention is v2-only (R2-2), belongs to the capture's owning thread (R3-P1), and is
            // fail-closed while that owner is still unknown (R4-P1b — never guessed from the chat).
            retainStoppedResult(data, linesRef.current, elapsedRef.current);
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
    if (autoScroll.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
  }, []);

  const handleStop = useCallback(async () => {
    const epoch = sessionEpochRef.current;
    try {
      await revokeMeetingShareBeforeCapture();
      // R6: the revoke wait can span a full stop+start elsewhere — never send the old round's control POST.
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
      // R6: judge again after the body completes — a summary finishing in the next round writes nothing.
      if (sessionEpochRef.current !== epoch) return;
      setStatus((prev) => ({ ...prev, running: false }));
      setSavedPath(data.summary?.transcript_path ?? null);
      setSavedRecordingPath(data.summary?.recording_path ?? null);
      setSavedRecordingPaths(data.summary?.recording_paths ?? {});
      if (data.summary) {
        retainStoppedResult(data.summary, linesRef.current, elapsedRef.current);
      }
    } catch {
      /* offline */
    }
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

  /** §1.14 语音 4 重新开始: drop the stopped session's remains so the prepare state shows again. */
  const handleStartAgain = useCallback(() => {
    invalidateSessionRound();
    clearMeetingSessionSummary();
    setLines([]);
    setElapsed(0);
    setSavedPath(null);
    setSavedRecordingPath(null);
    setSavedRecordingPaths({});
    setSavedResultOwner(null);
    setStartError(null);
    // R2-3: the numeric latency snapshot belongs to the discarded session — reset it with everything else.
    setStatus((prev) => ({ ...prev, avg_asr_latency: undefined }));
  }, []);

  const avgLatency = lines.length ? (lines.reduce((s, l) => s + l.asr_latency, 0) / lines.length).toFixed(2) : '—';
  // Live value comes from the actual lines (review P2-5); the status snapshot only fills the no-lines gap (e.g.
  // just-joined before the first chunk), and 重新开始 clears the lines so a prior value never leaks forward.
  const avgLatencySeconds =
    linesAvgLatency(lines) ?? (typeof status.avg_asr_latency === 'number' ? status.avg_asr_latency.toFixed(2) : null);
  const sourceLabel = status.inputs?.length
    ? status.inputs.map((input) => input.label ?? input.id).join(' + ')
    : status.app_name
      ? status.app_name
      : status.source === 'mic'
        ? 'Microphone'
        : '—';
  const hasSession =
    lines.length > 0 ||
    savedPath !== null ||
    savedRecordingPath !== null ||
    Object.keys(savedRecordingPaths).length > 0 ||
    elapsed > 0;

  if (presentation === 'v2') {
    return (
      <TranscriptPanelV2
        status={status}
        lines={lines}
        connected={connected}
        elapsed={elapsed}
        savedPath={savedPath}
        savedRecordingPath={savedRecordingPath}
        savedRecordingPaths={savedRecordingPaths}
        savedResultOwner={savedResultOwner}
        sources={sources}
        sourceError={sourceError}
        startError={startError}
        sourceLabel={sourceLabel}
        hasSession={hasSession}
        avgLatencySeconds={avgLatencySeconds}
        onStart={handleStart}
        onPause={handlePause}
        onResume={handleResume}
        onStop={handleStop}
        onStartAgain={handleStartAgain}
        onPopOut={() => setFloatingTranscriptVisible(true)}
        onCorrect={handleCorrect}
      />
    );
  }

  return (
    <TranscriptPanelClassicView
      status={status}
      lines={lines}
      connected={connected}
      elapsed={elapsed}
      savedPath={savedPath}
      savedRecordingPath={savedRecordingPath}
      savedRecordingPaths={savedRecordingPaths}
      sources={sources}
      sourceError={sourceError}
      startError={startError}
      scrollRef={scrollRef}
      onScrollBody={handleScroll}
      sourceLabel={sourceLabel}
      avgLatency={avgLatency}
      onStart={handleStart}
      onPause={handlePause}
      onResume={handleResume}
      onStop={handleStop}
      onPopOut={() => setFloatingTranscriptVisible(true)}
    />
  );
}
