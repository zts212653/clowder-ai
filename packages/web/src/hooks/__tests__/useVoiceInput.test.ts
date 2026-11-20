// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useVoiceInput } from '../useVoiceInput';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/utils/transcription-corrector', () => ({
  correctTranscription: (t: string) => `[corrected] ${t}`,
  mergeTermEntries: () => [],
}));

let microphoneDeviceId: string | null = null;
vi.mock('@/stores/voiceSettingsStore', () => ({
  useVoiceSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: { customTerms: [], customPrompt: null, language: 'zh', microphoneDeviceId },
    }),
}));

/* ── Mock infrastructure ── */

function createMockTrack() {
  return { stop: vi.fn(), kind: 'audio' as const, label: 'BlackHole 2ch', readyState: 'live' };
}

function createMockStream() {
  const track = createMockTrack();
  return { getTracks: () => [track], getAudioTracks: () => [track], _track: track };
}

function mockInputLevel(amplitude: () => number, audioTime = () => performance.now() / 1000) {
  const close = vi.fn(async () => {});
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      sampleRate = 48000;
      get currentTime() {
        return audioTime();
      }
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createAnalyser() {
        return {
          fftSize: 2048,
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(amplitude()),
          disconnect: vi.fn(),
        };
      }
      resume = vi.fn(async () => {});
      close = close;
    },
  );
  return close;
}

type Listener = (...args: unknown[]) => void;

class MockMediaRecorder {
  state = 'inactive';
  private listeners: Record<string, Listener[]> = {};
  static isTypeSupported = vi.fn(() => true);
  static _last: MockMediaRecorder | null = null;

  constructor(
    public stream: ReturnType<typeof createMockStream>,
    public options?: MediaRecorderOptions,
  ) {
    MockMediaRecorder._last = this;
  }

  addEventListener(event: string, fn: Listener) {
    (this.listeners[event] ??= []).push(fn);
  }

  start() {
    this.state = 'recording';
  }

  requestData() {
    // Simulate flushing current data — emits dataavailable with accumulated audio
    this._emit('dataavailable', { data: new Blob(['chunk'], { type: 'audio/webm' }) });
  }

  stop() {
    this.state = 'inactive';
    this._emit('dataavailable', { data: new Blob(['audio'], { type: 'audio/webm' }) });
    this._emit('stop');
  }

  _emit(event: string, data?: unknown) {
    for (const fn of this.listeners[event] ?? []) fn(data);
  }
}

/* ── Hook wrapper ── */

let captured: ReturnType<typeof import('../useVoiceInput').useVoiceInput> | null = null;

function HookHost() {
  captured = useVoiceInput();
  return null;
}

/* ── Setup / Teardown ── */

let root: Root;
let container: HTMLDivElement;
let mockStream: ReturnType<typeof createMockStream>;
const mockApiFetch = vi.mocked(apiFetch);

beforeEach(() => {
  vi.useFakeTimers();
  microphoneDeviceId = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  mockStream = createMockStream();
  MockMediaRecorder._last = null;
  MockMediaRecorder.isTypeSupported.mockReturnValue(true);

  Object.defineProperty(globalThis, 'MediaRecorder', {
    value: MockMediaRecorder,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn().mockResolvedValue(mockStream) },
    writable: true,
    configurable: true,
  });
  globalThis.fetch = vi.fn();
  mockApiFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ endpoints: {} }),
  } as Response);

  act(() => {
    root.render(React.createElement(HookHost));
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
  captured = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ── Helpers ── */

function hook() {
  return captured!;
}

function mockFetchOk(text: string) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ text }),
  });
}

function mockFetchFail(status: number) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
  });
}

/* ── Tests ── */

describe('useVoiceInput', () => {
  it('starts in idle state', () => {
    expect(hook().state).toBe('idle');
    expect(hook().transcript).toBe('');
    expect(hook().error).toBeNull();
    expect(hook().duration).toBe(0);
  });

  it('startRecording → recording state + calls getUserMedia', async () => {
    await act(async () => {
      await hook().startRecording();
    });
    expect(hook().state).toBe('recording');
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it('checks isTypeSupported for preferred mimeType', async () => {
    await act(async () => {
      await hook().startRecording();
    });
    expect(MockMediaRecorder.isTypeSupported).toHaveBeenCalledWith('audio/webm;codecs=opus');
  });

  it('falls back to default mimeType when preferred unsupported', async () => {
    MockMediaRecorder.isTypeSupported.mockReturnValue(false);
    await act(async () => {
      await hook().startRecording();
    });
    expect(MockMediaRecorder._last?.options).toEqual({});
  });

  it('sets error when getUserMedia denied', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Permission denied'));
    await act(async () => {
      await hook().startRecording();
    });
    expect(hook().state).toBe('idle');
    expect(hook().error).toBe('Permission denied');
  });

  it('requests the saved input exactly and reports when the browser cannot open it', async () => {
    microphoneDeviceId = 'unplugged-device';
    act(() => root.render(React.createElement(HookHost)));
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new DOMException('disconnected', 'NotFoundError'));
    await act(async () => hook().startRecording());
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: { deviceId: { exact: 'unplugged-device' } },
    });
    expect(hook().microphoneIssue).toEqual({ kind: 'device-unavailable' });
  });

  it('reports near-zero input with the capture track name and keeps it off ASR', async () => {
    const close = mockInputLevel(() => 0.00001);
    mockFetchOk('');
    await act(async () => hook().startRecording());
    await act(async () => vi.advanceTimersByTimeAsync(4200));
    await act(async () => hook().stopRecording());
    expect(hook().microphoneIssue).toEqual({ kind: 'no-signal', deviceLabel: 'BlackHole 2ch' });
    expect(hook().state).toBe('idle');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockStream._track.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('retires the last recording’s microphone warning when another input is selected', async () => {
    mockInputLevel(() => 0);
    await act(async () => hook().startRecording());
    await act(async () => vi.advanceTimersByTimeAsync(1800));
    await act(async () => hook().stopRecording());
    expect(hook().microphoneIssue?.kind).toBe('no-signal');
    microphoneDeviceId = 'built-in-device';
    act(() => root.render(React.createElement(HookHost)));
    expect(hook().microphoneIssue).toBeNull();
  });

  it('sends the final recording when speech starts after a long silent prefix', async () => {
    let amplitude = 0;
    mockInputLevel(() => amplitude);
    mockFetchOk('宪宪，帮我看看 TypeScript API');
    await act(async () => hook().startRecording());
    await act(async () => vi.advanceTimersByTimeAsync(3200));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    amplitude = 0.004;
    await act(async () => vi.advanceTimersByTimeAsync(350));
    await act(async () => hook().stopRecording());
    expect(hook().microphoneIssue).toBeNull();
    expect(hook().transcript).toContain('TypeScript API');
  });

  it('preserves ASR when the browser cannot confirm the level', async () => {
    mockStream._track.label = '';
    mockFetchOk('');
    await act(async () => hook().startRecording());
    await act(async () => vi.advanceTimersByTimeAsync(1600));
    await act(async () => hook().stopRecording());
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(hook().microphoneIssue).toEqual({ kind: 'no-transcript', deviceLabel: null });
  });

  it('preserves the captured audio when the meter clock misses part of the recording', async () => {
    mockInputLevel(
      () => 0,
      () => Math.max(0, performance.now() - 500) / 1000,
    );
    mockFetchOk('宪宪');
    await act(async () => hook().startRecording());
    await act(async () => vi.advanceTimersByTimeAsync(2200));
    await act(async () => hook().stopRecording());
    expect(hook().microphoneIssue).toBeNull();
    expect(hook().transcript).toContain('宪宪');
  });

  it('releases the meter and stream if recording cannot start after attaching the meter', async () => {
    const close = mockInputLevel(() => 0);
    vi.spyOn(MockMediaRecorder.prototype, 'start').mockImplementationOnce(() => {
      throw new Error('Recording could not start');
    });
    await act(async () => hook().startRecording());
    expect(mockStream._track.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(hook().error).toBe('Recording could not start');
  });

  it('cleans up stream on MediaRecorder constructor failure', async () => {
    class Failing {
      static isTypeSupported = vi.fn(() => true);
      constructor() {
        throw new Error('NotSupportedError');
      }
    }
    Object.defineProperty(globalThis, 'MediaRecorder', { value: Failing, writable: true, configurable: true });

    await act(async () => {
      await hook().startRecording();
    });
    expect(mockStream._track.stop).toHaveBeenCalled();
    expect(hook().error).toBe('NotSupportedError');
    expect(hook().state).toBe('idle');
  });

  it('updates duration while recording', async () => {
    await act(async () => {
      await hook().startRecording();
    });
    expect(hook().duration).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(hook().duration).toBeGreaterThanOrEqual(2);
  });

  it('full transcription flow: start → stop → transcript', async () => {
    mockFetchOk('你好世界');
    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });
    vi.setSystemTime(now + 1000);
    await act(async () => {
      hook().stopRecording();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(hook().transcript).toBe('[corrected] 你好世界');
    expect(hook().state).toBe('idle');
  });

  it('releases mic tracks on stop', async () => {
    mockFetchOk('test');
    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });
    vi.setSystemTime(now + 1000);
    await act(async () => {
      hook().stopRecording();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockStream._track.stop).toHaveBeenCalled();
  });

  it('ignores short recordings (< 500ms)', async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });
    vi.setSystemTime(now + 200);
    await act(async () => {
      hook().stopRecording();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(hook().state).toBe('idle');
  });

  it('sets error on Whisper HTTP error', async () => {
    mockFetchFail(500);
    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });
    vi.setSystemTime(now + 1000);
    await act(async () => {
      hook().stopRecording();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(hook().error).toBe('Whisper service error: 500');
    expect(hook().state).toBe('idle');
  });

  it('sets error on network failure', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });
    vi.setSystemTime(now + 1000);
    await act(async () => {
      hook().stopRecording();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(hook().error).toBe('Network error');
    expect(hook().state).toBe('idle');
  });

  it('stopRecording is no-op when idle', () => {
    act(() => {
      hook().stopRecording();
    });
    expect(hook().state).toBe('idle');
  });

  it('sends correct FormData to Whisper API', async () => {
    mockFetchOk('test');
    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });
    vi.setSystemTime(now + 1000);
    await act(async () => {
      hook().stopRecording();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9876/v1/audio/transcriptions');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeInstanceOf(FormData);
    expect((opts.body as FormData).get('language')).toBe('zh');
    expect((opts.body as FormData).get('initial_prompt')).toBeTruthy();
  });

  it('uses runtime service endpoints for custom voice service ports', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          endpoints: {
            'whisper-stt': 'http://127.0.0.1:19976',
            'llm-postprocess': 'http://localhost:19978',
          },
        }),
    } as Response);
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: 'raw transcript' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: 'refined transcript' }) });
    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });
    vi.setSystemTime(now + 1000);
    await act(async () => {
      hook().stopRecording();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'http://127.0.0.1:19976/v1/audio/transcriptions',
    );
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(
      'http://127.0.0.1:19978/v1/text/refine',
    );
    expect(hook().transcript).toBe('[corrected] refined transcript');
  });

  it('clears previous error on new recording', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce(createMockStream());

    await act(async () => {
      await hook().startRecording();
    });
    expect(hook().error).toBe('first fail');

    await act(async () => {
      await hook().startRecording();
    });
    expect(hook().error).toBeNull();
    expect(hook().state).toBe('recording');
  });

  /* ── Streaming transcription (F20b) ── */

  it('updates partialTranscript via streaming interval', async () => {
    // First call: streaming partial; later calls: final transcription
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: '你好' }) })
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ text: '完整' }) });

    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });
    expect(hook().partialTranscript).toBe('');

    // Advance past stream interval (3000ms) + requestData delay (50ms)
    // Use advanceTimersByTimeAsync to also flush promises
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    expect(hook().partialTranscript).toBe('[corrected] 你好');
  });

  it('clears partialTranscript after final transcription', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: '部分' }) })
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ text: '完整结果' }) });

    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });

    // Trigger streaming partial
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    // Stop recording (enough time elapsed)
    vi.setSystemTime(now + 4000);
    await act(async () => {
      hook().stopRecording();
      // Flush the async transcribeBlob promise chain
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(hook().partialTranscript).toBe('');
    expect(hook().transcript).toBe('[corrected] 完整结果');
    expect(hook().state).toBe('idle');
  });

  it('streaming errors are non-fatal', async () => {
    // Streaming fetch fails, but final transcription succeeds
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('network glitch'))
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ text: '最终结果' }) });

    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });

    // Trigger streaming — should fail silently
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    expect(hook().error).toBeNull();
    expect(hook().state).toBe('recording');

    // Stop and get final transcription
    vi.setSystemTime(now + 4000);
    await act(async () => {
      hook().stopRecording();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(hook().transcript).toBe('[corrected] 最终结果');
    expect(hook().error).toBeNull();
  });

  it('partialTranscript starts empty on new recording', async () => {
    mockFetchOk('test');
    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });
    expect(hook().partialTranscript).toBe('');
  });

  it('allows one client preview in flight and submits the final after aborting it', async () => {
    let resolvePreview!: (v: { ok: boolean; json: () => Promise<{ text: string }> }) => void;
    const preview = new Promise<{ ok: boolean; json: () => Promise<{ text: string }> }>((resolve) => {
      resolvePreview = resolve;
    });
    const fetchMock = vi.mocked(fetch);
    mockFetchOk('final');
    fetchMock.mockReturnValueOnce(preview as Promise<Response>);

    await act(async () => {
      await hook().startRecording();
      await vi.advanceTimersByTimeAsync(9500);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const previewSignal = fetchMock.mock.calls[0][1]?.signal;
    expect(previewSignal?.aborted).toBe(false);

    await act(async () => {
      hook().stopRecording();
    });

    expect(previewSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3); // preview, full recording, post-processing
    expect(hook().transcript).toBe('[corrected] final');

    await act(async () => {
      resolvePreview({ ok: true, json: () => Promise.resolve({ text: 'stale preview' }) });
    });

    expect(hook().partialTranscript).toBe('');
    expect(hook().transcript).toBe('[corrected] final');
  });

  it('does not submit a preview if recording stops while waiting for dataavailable', async () => {
    mockFetchOk('final');

    await act(async () => {
      await hook().startRecording();
      await vi.advanceTimersByTimeAsync(3000);
      hook().stopRecording();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:9876/v1/audio/transcriptions',
      'http://127.0.0.1:9878/v1/text/refine',
    ]);
    expect(hook().transcript).toBe('[corrected] final');
  });
});
