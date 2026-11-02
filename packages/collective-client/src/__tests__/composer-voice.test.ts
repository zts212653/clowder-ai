// @vitest-environment jsdom
import { VoiceCapture } from '@cat-cafe/ui';
import { afterEach, expect, it, vi } from 'vitest';
import { clearConfirmedComposerDraft, emptyDraft } from '../composer-draft.js';
import { applyComposerTranscript, publishComposerTranscript } from '../composer-voice-draft.js';
import { connectDeviceVoiceService, deviceVoiceEndpoint } from '../device-voice-service.js';
import type { MessageExpressionPort } from '../message-expression-context.js';

afterEach(() => vi.unstubAllGlobals());
const voiceDraft = { captureId: 'capture-original', state: 'transcribing' as const, applied: false };

it('appends a transcription once to the original capture while retaining words edited during transcription', () => {
  const current = { ...emptyDraft, body: '刚刚补上的文字', voiceDraft };
  const applied = applyComposerTranscript(current, voiceDraft.captureId, '已经说完的话');
  expect(applied.body).toBe('刚刚补上的文字\n已经说完的话');
  expect(applyComposerTranscript(applied, voiceDraft.captureId, '已经说完的话')).toBe(applied);
  const newer = { ...current, voiceDraft: { ...voiceDraft, captureId: 'a-new-recording' } };
  expect(applyComposerTranscript(newer, voiceDraft.captureId, '迟到的结果')).toBe(newer);
  expect(clearConfirmedComposerDraft(newer, current)).toBe(newer);
});

it('keeps an overlong transcription available without replacing or truncating the existing draft', () => {
  const current = { ...emptyDraft, body: '字'.repeat(32_000), voiceDraft };
  const result = applyComposerTranscript(current, voiceDraft.captureId, '保留录音');
  expect(result.body).toBe(current.body);
  expect(result.voiceDraft).toMatchObject({ state: 'ready', transcript: '保留录音', applied: false });
});

it('does not replace an independently advanced private draft with a late transcription', async () => {
  const draft = { revision: 8, content: { ...emptyDraft, body: '另一窗口更新', voiceDraft } };
  const saveDraft = vi.fn();
  const port = { channelState: vi.fn(async () => ({ draft })), saveDraft } as unknown as MessageExpressionPort;
  expect(
    await publishComposerTranscript(port, 'original-channel', undefined, voiceDraft.captureId, '迟到结果', 7),
  ).toEqual({ status: 'conflict', draft });
  expect(saveDraft).not.toHaveBeenCalled();
  draft.content.voiceDraft = { ...voiceDraft, captureId: 'new-capture' };
  await publishComposerTranscript(port, 'original-channel', undefined, voiceDraft.captureId, '迟到结果');
  expect(saveDraft).not.toHaveBeenCalled();
});

class Recorder extends EventTarget {
  static isTypeSupported(value: string) {
    return value === 'audio/webm;codecs=opus';
  }
  static instances: Recorder[] = [];
  state = 'inactive';
  readonly mimeType = 'audio/webm;codecs=opus';
  constructor(_stream: MediaStream) {
    super();
    Recorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['recorded bytes']) }));
      this.dispatchEvent(new Event('stop'));
    });
  }
}

it('stops a permission request that resolves after navigation without ever starting a recorder', async () => {
  const track = { stop: vi.fn() };
  let grant: ((stream: MediaStream) => void) | undefined;
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    },
  });
  vi.stubGlobal('MediaRecorder', Recorder);
  const onStop = vi.fn();
  const before = Recorder.instances.length;
  const capture = new VoiceCapture({ onChunk: vi.fn(), onError: vi.fn(), onStop });
  const started = capture.start();
  capture.stop();
  grant!({ getTracks: () => [track] } as unknown as MediaStream);
  expect(await started).toBe(false);
  expect(track.stop).toHaveBeenCalledOnce();
  expect(Recorder.instances).toHaveLength(before);
  expect(onStop).not.toHaveBeenCalled();
});

it('stops the microphone synchronously and retains the final bytes; explicit cancellation suppresses those bytes', async () => {
  const track = { stop: vi.fn() };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  vi.stubGlobal('MediaRecorder', Recorder);
  const onStop = vi.fn();
  const capture = new VoiceCapture({ onChunk: vi.fn(), onError: vi.fn(), onStop });
  await capture.start();
  capture.stop();
  expect(track.stop).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(onStop).toHaveBeenCalledOnce();
  expect(onStop.mock.calls[0][0].size).toBeGreaterThan(0);
  const cancelled = new VoiceCapture({ onChunk: vi.fn(), onError: vi.fn(), onStop });
  await cancelled.start();
  cancelled.cancel();
  await Promise.resolve();
  expect(onStop).toHaveBeenCalledOnce();
});

it('requires an explicitly supplied local service and never falls back to a conventional port or another Café', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  for (const value of [
    '',
    'https://another-cafe.example',
    'file:///tmp/service',
    'http://127.0.0.1:5555/?key=unexpected',
  ])
    expect(() => deviceVoiceEndpoint(value)).toThrow();
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'loading' })));
  await expect(connectDeviceVoiceService('http://127.0.0.1:5555', new AbortController().signal)).rejects.toThrow(
    'not ready',
  );
  request
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'Editable words' })));
  const service = await connectDeviceVoiceService('http://127.0.0.1:5555', new AbortController().signal);
  expect(
    await service.transcribe(new Blob(['recording'], { type: 'audio/webm' }), 'en', new AbortController().signal),
  ).toBe('Editable words');
  expect(request.mock.calls.at(-1)).toMatchObject([
    'http://127.0.0.1:5555/v1/audio/transcriptions',
    { credentials: 'omit', redirect: 'error' },
  ]);
});
