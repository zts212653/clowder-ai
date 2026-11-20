'use client';

import { deploymentDefaults } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVoiceSettingsStore } from '@/stores/voiceSettingsStore';
import { apiFetch } from '@/utils/api-client';
import { correctTranscription, mergeTermEntries, type TermEntry } from '@/utils/transcription-corrector';
import { type MicrophoneIssue, microphoneAccessIssue } from './microphone-errors';
import { monitorVoiceInputSignal, type VoiceInputSignal } from './voice-input-signal';

function normalizeLoopbackUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.hostname !== 'localhost') return endpoint;
    const hadTrailingSlash = endpoint.endsWith('/');
    url.hostname = '127.0.0.1';
    const serialized = url.toString();
    return !hadTrailingSlash && url.pathname === '/' ? serialized.replace(/\/$/, '') : serialized;
  } catch {
    return endpoint;
  }
}

const DEFAULT_WHISPER_URL = normalizeLoopbackUrl(process.env.NEXT_PUBLIC_WHISPER_URL || 'http://127.0.0.1:9876');
const DEFAULT_LLM_POSTPROCESS_URL = normalizeLoopbackUrl(
  process.env.NEXT_PUBLIC_LLM_POSTPROCESS_URL || 'http://127.0.0.1:9878',
);

const DEFAULT_PROMPT =
  `以下是 ${deploymentDefaults.brand.displayName} 的录音，聊天对象的名字写作「宪宪」「砚砚」，` +
  '技术词：worktree、review、TypeScript、pull request、Redis、Slack、rebase、main。';

/** Minimum recording duration (ms) to avoid accidental taps. */
const MIN_RECORDING_MS = 500;

/** Interval (ms) between intermediate streaming transcriptions. */
const STREAM_INTERVAL_MS = 3000;

export type VoiceState = 'idle' | 'recording' | 'transcribing';

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function buildFormData(blob: Blob, prompt: string, language: string): FormData {
  const formData = new FormData();
  formData.append('file', blob, 'recording.webm');
  formData.append('initial_prompt', prompt);
  if (language) formData.append('language', language);
  return formData;
}

async function resolveVoiceServiceEndpoint(serviceId: string, fallback: string, signal?: AbortSignal): Promise<string> {
  try {
    const res = await apiFetch('/api/services/endpoints', signal ? { signal } : undefined);
    if (!res.ok) return fallback;
    const payload: { endpoints?: Record<string, unknown> } = await res.json();
    const endpoint = payload.endpoints?.[serviceId];
    if (typeof endpoint === 'string' && endpoint.trim().length > 0) {
      return normalizeLoopbackUrl(endpoint.trim());
    }
  } catch {
    // Keep voice input usable when the API endpoint map is temporarily unavailable.
  }
  return fallback;
}

async function transcribeBlob(blob: Blob, prompt: string, language: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const whisperUrl = await resolveVoiceServiceEndpoint('whisper-stt', DEFAULT_WHISPER_URL, signal);
  signal?.throwIfAborted();
  const res = await fetch(`${whisperUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    body: buildFormData(blob, prompt, language),
    signal,
  });

  if (!res.ok) throw new Error(`Whisper service error: ${res.status}`);

  const data: { text?: string } = await res.json();
  return data.text || '';
}

/**
 * Optional LLM post-processing: sends raw ASR text to a local LLM for error correction.
 * Gracefully falls back to original text if the server is unavailable.
 */
async function llmPostProcess(text: string): Promise<string> {
  if (!text.trim()) return text;
  try {
    const llmPostprocessUrl = await resolveVoiceServiceEndpoint('llm-postprocess', DEFAULT_LLM_POSTPROCESS_URL);
    const res = await fetch(`${llmPostprocessUrl}/v1/text/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return text; // Server error → fall back to raw
    const data: { text?: string } = await res.json();
    return data.text || text;
  } catch {
    // Server not running or network error → silently skip
    return text;
  }
}

export function useVoiceInput() {
  const settings = useVoiceSettingsStore((s) => s.settings);

  const prompt = settings.customPrompt || DEFAULT_PROMPT;
  const language = settings.language;

  // Rebuild merged term entries when custom terms change
  const mergedEntries: ReadonlyArray<TermEntry> = useMemo(
    () => mergeTermEntries(settings.customTerms),
    [settings.customTerms],
  );

  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [microphoneIssue, setMicrophoneIssue] = useState<MicrophoneIssue | null>(null);
  const [duration, setDuration] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new input retires the previous attempt's warning
  useEffect(() => {
    setMicrophoneIssue(null);
  }, [settings.microphoneDeviceId]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const signalRef = useRef<VoiceInputSignal | null>(null);
  const openingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const versionRef = useRef(0);
  const previewRef = useRef<AbortController | null>(null);

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamTimerRef.current) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    previewRef.current?.abort();
    previewRef.current = null;
  }, []);

  useEffect(
    () => () => {
      versionRef.current++;
      clearTimers();
      signalRef.current?.close();
      signalRef.current = null;
      openingRef.current = false;
      const recorder = mediaRecorderRef.current;
      mediaRecorderRef.current = null;
      if (recorder?.state === 'recording') recorder.stop();
    },
    [clearTimers],
  );

  const finishRecording = useCallback(
    async (chunks: Blob[], startedAt: number, version: number, deviceLabel: string | null, isSilent: boolean) => {
      if (version !== versionRef.current) return;
      clearTimers();
      if (isSilent || Date.now() - startedAt < MIN_RECORDING_MS) {
        if (isSilent) setMicrophoneIssue({ kind: 'no-signal', deviceLabel });
        setPartialTranscript('');
        setState('idle');
        return;
      }

      setState('transcribing');
      try {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const raw = await transcribeBlob(blob, prompt, language);
        const refined = await llmPostProcess(raw);
        if (version !== versionRef.current) return;
        const text = refined.trim() ? correctTranscription(refined, mergedEntries) : '';
        if (text.trim()) setTranscript(text);
        else setMicrophoneIssue({ kind: 'no-transcript', deviceLabel });
        setPartialTranscript('');
      } catch (err) {
        if (version === versionRef.current) {
          setError(err instanceof Error ? err.message : 'Transcription failed');
        }
      } finally {
        if (version === versionRef.current) setState('idle');
      }
    },
    [clearTimers, prompt, language, mergedEntries],
  );

  const refreshPreview = useCallback(
    async (recorder: MediaRecorder, chunks: Blob[], version: number) => {
      const isRecording = () => version === versionRef.current && recorder.state === 'recording';
      if (!isRecording() || previewRef.current || signalRef.current?.isSilent()) return;
      const preview = new AbortController();
      previewRef.current = preview;
      try {
        const chunkCount = chunks.length;
        recorder.requestData();
        // Give dataavailable a turn to deliver the requested recording data.
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (!isRecording() || preview.signal.aborted || chunkCount === chunks.length) return;
        const raw = await transcribeBlob(new Blob(chunks, { type: 'audio/webm' }), prompt, language, preview.signal);
        if (isRecording() && !preview.signal.aborted) {
          setPartialTranscript(correctTranscription(raw, mergedEntries));
        }
      } catch {
        // A preview failure does not fail the recording.
      } finally {
        if (previewRef.current === preview) previewRef.current = null;
      }
    },
    [prompt, language, mergedEntries],
  );

  const startRecording = useCallback(async () => {
    if (state !== 'idle' || openingRef.current || mediaRecorderRef.current) return;
    const myVersion = ++versionRef.current;
    openingRef.current = true;
    let stream: MediaStream | undefined;
    try {
      setError(null);
      setMicrophoneIssue(null);
      setTranscript('');
      setPartialTranscript('');
      setDuration(0);

      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        setMicrophoneIssue({ kind: 'unsupported' });
        return;
      }
      const deviceId = settings.microphoneDeviceId;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      if (myVersion !== versionRef.current) {
        stopTracks(stream);
        return;
      }

      const preferredMime = 'audio/webm;codecs=opus';
      const mimeType = MediaRecorder.isTypeSupported(preferredMime) ? preferredMime : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mediaRecorderRef.current = recorder;
      const chunks: Blob[] = [];
      const startedAt = Date.now();
      const deviceLabel = stream.getAudioTracks()[0]?.label?.trim() || null;

      recorder.addEventListener('dataavailable', (e: BlobEvent) => {
        if (e.data.size > 0) chunks.push(e.data);
      });

      recorder.addEventListener('stop', () => {
        let isSilent = false;
        if (mediaRecorderRef.current === recorder) {
          isSilent = signalRef.current?.isSilent() ?? false;
          signalRef.current?.close();
          signalRef.current = null;
          mediaRecorderRef.current = null;
        }
        stopTracks(recorder.stream);
        void finishRecording(chunks, startedAt, myVersion, deviceLabel, isSilent);
      });

      signalRef.current = monitorVoiceInputSignal(stream);
      recorder.start();
      setState('recording');

      // Duration timer
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startedAt) / 1000));
      }, 1000);

      // Streaming: periodic intermediate transcription
      streamTimerRef.current = setInterval(() => {
        void refreshPreview(recorder, chunks, myVersion);
      }, STREAM_INTERVAL_MS);
    } catch (err) {
      if (stream) stopTracks(stream);
      if (myVersion !== versionRef.current) return;
      signalRef.current?.close();
      signalRef.current = null;
      mediaRecorderRef.current = null;
      const issue = microphoneAccessIssue(err);
      if (issue) setMicrophoneIssue({ kind: issue });
      else setError(err instanceof Error ? err.message : 'Could not start recording');
      setState('idle');
    } finally {
      if (myVersion === versionRef.current) openingRef.current = false;
    }
  }, [finishRecording, refreshPreview, settings.microphoneDeviceId, state]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      clearTimers();
      mediaRecorderRef.current.stop();
    }
  }, [clearTimers]);

  return {
    state,
    transcript,
    partialTranscript,
    error,
    microphoneIssue,
    duration,
    startRecording,
    stopRecording,
  };
}
