import { resolveAudioServiceUrl } from './audio-proxy.js';

const MAX_EVENT_CHARS = 64_000;
const MAX_TRANSCRIPT_CHARS = 8_000;
const MAX_LABEL_CHARS = 256;
const DEFAULT_STREAM_ROTATION_INTERVAL_MS = 30_000;

export type RealtimeCompanionAudioState =
  | { readonly state: 'ready' }
  | { readonly state: 'not_running' }
  | { readonly state: 'thread_mismatch'; readonly activeThreadId: string }
  | { readonly state: 'unavailable' };

export interface RealtimeCompanionTranscript {
  readonly text: string;
  readonly observedAt: number;
  readonly inputId?: string;
  readonly inputSource?: string;
  readonly inputLabel?: string;
  readonly speakerLabel?: string;
}

export interface RealtimeCompanionAudioSubscription {
  readonly closed: Promise<void>;
  close(): void;
}

interface RealtimeCompanionAudioCallbacks {
  readonly onTranscript: (transcript: RealtimeCompanionTranscript) => void | Promise<void>;
  readonly onStopped?: () => void | Promise<void>;
  readonly onError?: (error: Error) => void | Promise<void>;
}

interface AudioEventStream {
  readonly controller: AbortController;
  readonly stream: ReadableStream<Uint8Array>;
}

interface AudioSubscriptionState {
  closedByClient: boolean;
  current: AudioEventStream;
}

export interface RealtimeCompanionAudioSource {
  inspect(threadId: string): Promise<RealtimeCompanionAudioState>;
  subscribe(threadId: string, callbacks: RealtimeCompanionAudioCallbacks): Promise<RealtimeCompanionAudioSubscription>;
}

export function createRealtimeCompanionAudioSource(input?: {
  readonly url?: string;
  readonly fetchFn?: typeof fetch;
  readonly rotationIntervalMs?: number;
}): RealtimeCompanionAudioSource {
  const fetchFn = input?.fetchFn ?? fetch;
  const serviceUrl = input?.url ?? resolveAudioServiceUrl();
  const rotationIntervalMs = Math.max(1, input?.rotationIntervalMs ?? DEFAULT_STREAM_ROTATION_INTERVAL_MS);
  const inspect = (threadId: string) => inspectCapture(fetchFn, serviceUrl, threadId);
  return {
    inspect,
    subscribe: async (threadId, callbacks) => {
      const state: AudioSubscriptionState = {
        closedByClient: false,
        current: await openAudioEventStream(fetchFn, serviceUrl),
      };
      return {
        closed: runAudioSubscription({
          state,
          threadId,
          callbacks,
          inspect,
          open: () => openAudioEventStream(fetchFn, serviceUrl),
          rotationIntervalMs,
        }),
        close: () => {
          state.closedByClient = true;
          state.current.controller.abort();
        },
      };
    },
  };
}

async function runAudioSubscription(input: {
  readonly state: AudioSubscriptionState;
  readonly threadId: string;
  readonly callbacks: RealtimeCompanionAudioCallbacks;
  readonly inspect: (threadId: string) => Promise<RealtimeCompanionAudioState>;
  readonly open: () => Promise<AudioEventStream>;
  readonly rotationIntervalMs: number;
}): Promise<void> {
  try {
    while (!input.state.closedByClient) {
      const outcome = await pumpAudioEvents(
        input.state.current.stream,
        input.callbacks,
        input.state.current.controller.signal,
        input.rotationIntervalMs,
      );
      const next = await advanceAudioSubscription(input, outcome);
      if (!next) return;
      input.state.current = next;
    }
  } catch (error) {
    if (!input.state.closedByClient) {
      await input.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

async function advanceAudioSubscription(
  input: Parameters<typeof runAudioSubscription>[0],
  outcome: 'ended' | 'rotated' | 'stopped',
): Promise<AudioEventStream | null> {
  if (input.state.closedByClient || outcome === 'stopped') return null;
  if (outcome === 'ended') throw new Error('audio_event_stream_ended');
  const capture = await input.inspect(input.threadId);
  if (input.state.closedByClient) return null;
  if (capture.state === 'not_running' || capture.state === 'thread_mismatch') {
    await input.callbacks.onStopped?.();
    return null;
  }
  if (capture.state !== 'ready') throw new Error('audio_event_stream_status_unavailable');
  const next = await input.open();
  if (!input.state.closedByClient) return next;
  next.controller.abort();
  return null;
}

async function inspectCapture(
  fetchFn: typeof fetch,
  serviceUrl: string,
  threadId: string,
): Promise<RealtimeCompanionAudioState> {
  try {
    const response = await fetchFn(`${serviceUrl}/status`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return { state: 'unavailable' };
    const status = asRecord(await response.json());
    if (status?.running !== true) return { state: 'not_running' };
    const activeThreadId = boundedString(status.thread_id, MAX_LABEL_CHARS);
    if (!activeThreadId || activeThreadId !== threadId) {
      return { state: 'thread_mismatch', activeThreadId: activeThreadId ?? 'unknown' };
    }
    return { state: 'ready' };
  } catch {
    return { state: 'unavailable' };
  }
}

async function openAudioEventStream(fetchFn: typeof fetch, serviceUrl: string): Promise<AudioEventStream> {
  const controller = new AbortController();
  const response = await fetchFn(`${serviceUrl}/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const stream = response.body;
  if (!response.ok || !stream) {
    controller.abort();
    throw new Error(`audio_event_stream_unavailable:${response.status}`);
  }
  return { controller, stream };
}

async function pumpAudioEvents(
  stream: ReadableStream<Uint8Array>,
  callbacks: RealtimeCompanionAudioCallbacks,
  signal: AbortSignal,
  rotationIntervalMs: number,
): Promise<'ended' | 'rotated' | 'stopped'> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let rotationTimer: ReturnType<typeof setTimeout> | undefined;
  const rotate = new Promise<{ rotated: true }>((resolve) => {
    rotationTimer = setTimeout(() => resolve({ rotated: true }), rotationIntervalMs);
    rotationTimer.unref?.();
  });
  try {
    while (!signal.aborted) {
      const next = await Promise.race([reader.read(), rotate]);
      if ('rotated' in next) return 'rotated';
      const { value, done } = next;
      if (done) return 'ended';
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_EVENT_CHARS * 2) throw new Error('audio_event_stream_frame_too_large');
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if ((await consumeFrame(frame, callbacks)) === 'stopped') return 'stopped';
      }
    }
    return 'ended';
  } finally {
    if (rotationTimer) clearTimeout(rotationTimer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function consumeFrame(
  frame: string,
  callbacks: RealtimeCompanionAudioCallbacks,
): Promise<'continue' | 'stopped'> {
  const event = parseFrame(frame);
  if (!event) return 'continue';
  if (event.type === 'status' && event.status === 'stopped') {
    await callbacks.onStopped?.();
    return 'stopped';
  }
  const transcript = projectTranscript(event);
  if (transcript) await callbacks.onTranscript(transcript);
  return 'continue';
}

function parseFrame(frame: string): Record<string, unknown> | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  if (data.length > MAX_EVENT_CHARS) throw new Error('audio_event_stream_frame_too_large');
  try {
    return asRecord(JSON.parse(data));
  } catch {
    return null;
  }
}

function projectTranscript(event: Record<string, unknown>): RealtimeCompanionTranscript | null {
  if (event.type !== 'transcript' || event.asr_error !== undefined) return null;
  const text = boundedString(event.text, MAX_TRANSCRIPT_CHARS);
  if (!text || text.startsWith('[ASR error')) return null;
  const ts = typeof event.ts === 'number' && Number.isFinite(event.ts) && event.ts > 0 ? event.ts : Date.now();
  const inputId = boundedString(event.input_id, MAX_LABEL_CHARS);
  const inputSource = boundedString(event.input_source, MAX_LABEL_CHARS);
  const inputLabel = boundedString(event.input_label, MAX_LABEL_CHARS);
  const speakerLabel = boundedString(event.speaker_label, MAX_LABEL_CHARS);
  return {
    text,
    observedAt: ts < 10_000_000_000 ? Math.round(ts * 1_000) : Math.round(ts),
    ...(inputId ? { inputId } : {}),
    ...(inputSource ? { inputSource } : {}),
    ...(inputLabel ? { inputLabel } : {}),
    ...(speakerLabel ? { speakerLabel } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length > maxLength) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
