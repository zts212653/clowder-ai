'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useVoiceSettingsStore } from '@/stores/voiceSettingsStore';
import { correctTranscription, mergeTermEntries, type TermEntry } from '@/utils/transcription-corrector';

const WHISPER_URL = process.env.NEXT_PUBLIC_WHISPER_URL || 'http://localhost:9876';
const LLM_POSTPROCESS_URL = process.env.NEXT_PUBLIC_LLM_POSTPROCESS_URL || 'http://localhost:9878';

const DEFAULT_PROMPT =
  '这是 Clowder AI 猫猫协作项目的对话。宪宪是布偶猫（Claude Opus），砚砚是缅因猫（Codex）。' +
  '铲屎官经常说：帮我看看、开个 worktree、跑一下测试、review 一下、rebase 到 main。' +
  '技术栈：MCP, Redis, Fastify, TypeScript, Whisper, NDJSON, Zustand, WebSocket, ' +
  'InvocationRecord, Hindsight, Codex, Gemini, Claude, Opus, Sonnet, Haiku, ADR, Lua, CAS。';

/** Minimum recording duration (ms) to avoid accidental taps. */
const MIN_RECORDING_MS = 500;

/** Interval (ms) between intermediate streaming transcriptions. */
const STREAM_INTERVAL_MS = 3000;

export type VoiceState = 'idle' | 'recording' | 'transcribing';

function buildFormData(blob: Blob, prompt: string, language: string): FormData {
  const formData = new FormData();
  formData.append('file', blob, 'recording.webm');
  formData.append('initial_prompt', prompt);
  if (language) formData.append('language', language);
  return formData;
}

async function transcribeBlob(blob: Blob, prompt: string, language: string): Promise<string> {
  const res = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    body: buildFormData(blob, prompt, language),
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
    const res = await fetch(`${LLM_POSTPROCESS_URL}/v1/text/refine`, {
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
  const [duration, setDuration] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const versionRef = useRef(0);
  const streamSeqRef = useRef(0);
  // Snapshot settings at recording start to avoid mid-recording changes
  const promptRef = useRef(prompt);
  const languageRef = useRef(language);
  const entriesRef = useRef(mergedEntries);

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamTimerRef.current) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      setTranscript('');
      setPartialTranscript('');
      setDuration(0);
      versionRef.current++;
      streamSeqRef.current = 0;

      // Snapshot current settings
      promptRef.current = prompt;
      languageRef.current = language;
      entriesRef.current = mergedEntries;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      let recorder: MediaRecorder;
      try {
        const preferredMime = 'audio/webm;codecs=opus';
        const mimeType = MediaRecorder.isTypeSupported(preferredMime) ? preferredMime : undefined;
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      } catch (recErr) {
        stream.getTracks().forEach((t) => t.stop());
        throw recErr;
      }
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.addEventListener('dataavailable', (e: BlobEvent) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      });

      recorder.addEventListener('stop', async () => {
        stream.getTracks().forEach((t) => t.stop());
        clearTimers();

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });

        if (Date.now() - startTimeRef.current < MIN_RECORDING_MS) {
          setState('idle');
          return;
        }

        setState('transcribing');
        const myVersion = versionRef.current;

        try {
          const raw = await transcribeBlob(blob, promptRef.current, languageRef.current);
          const refined = await llmPostProcess(raw);
          if (myVersion === versionRef.current) {
            setTranscript(correctTranscription(refined, entriesRef.current));
            setPartialTranscript('');
          }
        } catch (err) {
          if (myVersion === versionRef.current) {
            setError(err instanceof Error ? err.message : 'Transcription failed');
          }
        } finally {
          if (myVersion === versionRef.current) setState('idle');
        }
      });

      recorder.start();
      startTimeRef.current = Date.now();
      setState('recording');

      // Duration timer
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      // Streaming: periodic intermediate transcription
      const myVersion = versionRef.current;
      streamTimerRef.current = setInterval(async () => {
        if (recorder.state !== 'recording') return;
        try {
          recorder.requestData();
          // Small delay to let dataavailable fire
          await new Promise((r) => setTimeout(r, 50));
          if (chunksRef.current.length === 0) return;
          const seq = ++streamSeqRef.current;
          const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
          const raw = await transcribeBlob(blob, promptRef.current, languageRef.current);
          if (myVersion === versionRef.current && seq === streamSeqRef.current && recorder.state === 'recording') {
            setPartialTranscript(correctTranscription(raw, entriesRef.current));
          }
        } catch {
          // Streaming errors are non-fatal, final transcription will retry
        }
      }, STREAM_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microphone access denied');
      setState('idle');
    }
  }, [clearTimers, prompt, language, mergedEntries]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  return {
    state,
    transcript,
    partialTranscript,
    error,
    duration,
    startRecording,
    stopRecording,
  };
}
