import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceInput } from '../useVoiceInput';

vi.mock('@/utils/transcription-corrector', () => ({
  correctTranscription: (t: string) => `[corrected] ${t}`,
  mergeTermEntries: () => [],
}));

vi.mock('@/stores/voiceSettingsStore', () => ({
  useVoiceSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: { customTerms: [], customPrompt: null, language: 'zh' },
    }),
}));

/* ── Mock infrastructure ── */

function createMockTrack() {
  return { stop: vi.fn(), kind: 'audio' as const };
}

function createMockStream() {
  const track = createMockTrack();
  return { getTracks: () => [track], _track: track };
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

beforeEach(() => {
  vi.useFakeTimers();
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
    expect(url).toContain('/v1/audio/transcriptions');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeInstanceOf(FormData);
    expect((opts.body as FormData).get('language')).toBe('zh');
    expect((opts.body as FormData).get('initial_prompt')).toBeTruthy();
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

  it('slow streaming response does not overwrite newer partialTranscript', async () => {
    // Simulate: request 1 (slow, 200ms) returns "older", request 2 (fast, 50ms) returns "newer"
    // Without sequence protection, "older" overwrites "newer" → bug
    let resolveOlder!: (v: { ok: boolean; json: () => Promise<{ text: string }> }) => void;
    const olderPromise = new Promise<{ ok: boolean; json: () => Promise<{ text: string }> }>((r) => {
      resolveOlder = r;
    });

    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(olderPromise) // 1st: slow
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ text: 'newer' }) }) // 2nd: fast
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ text: 'final' }) }); // final

    const now = Date.now();
    vi.setSystemTime(now);

    await act(async () => {
      await hook().startRecording();
    });

    // Trigger 1st streaming interval (t=3000) — request starts, doesn't resolve yet
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    // Trigger 2nd streaming interval (t=6000) — resolves fast with "newer"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    expect(hook().partialTranscript).toBe('[corrected] newer');

    // Now resolve the slow 1st request with "older" — must NOT overwrite "newer"
    await act(async () => {
      resolveOlder({ ok: true, json: () => Promise.resolve({ text: 'older' }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook().partialTranscript).toBe('[corrected] newer');
  });
});
