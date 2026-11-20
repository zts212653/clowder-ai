import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { destroyPlaybackRuntime } from '@/services/playbackRuntime';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { type UseTtsReturn, useTts } from '../useTts';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let current: UseTtsReturn;
let host: HTMLDivElement;
let root: Root;
let messageId: string;
let selected: 'old' | 'new';
const played: string[] = [];
const warning = '未配置本人声线，本次使用全局默认声音。';

function assetEvent(suffix: string, warn = false) {
  return `data: ${JSON.stringify({
    type: 'asset',
    audioUrl: `/api/tts/audio/${messageId}-${suffix}.wav`,
    voiceSelection: { warnings: warn ? [warning] : [] },
  })}\n\n`;
}

function Harness() {
  current = useTts();
  return (
    <button type="button" onClick={() => current.synthesize(messageId, '同一消息。', 'codex61-sol')}>
      朗读
    </button>
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  played.length = 0;
  selected = 'old';
  useToastStore.setState({ toasts: [] });
  let nextBlob = 0;
  Object.assign(URL, { createObjectURL: vi.fn(() => `blob:${messageId}-${++nextBlob}`), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (this: HTMLMediaElement) {
    played.push(this.src);
  });
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    path === '/api/tts/listen/stream' ? new Response(assetEvent(selected, selected === 'old')) : new Response('audio'),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => {
    current?.stop();
    destroyPlaybackRuntime();
    root.unmount();
  });
  host.remove();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function renderAndPlay(id: string) {
  messageId = id;
  await act(async () => root.render(<Harness />));
  await act(async () => {
    host.querySelector('button')?.click();
    await vi.waitFor(() => expect(played.length).toBe(1));
  });
}

it('surfaces the actual voice warning before ordinary message playback', async () => {
  await renderAndPlay('voice-warning');
  expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain(warning);
});

it('retains the read-aloud error state when playback is rejected after synthesis', async () => {
  messageId = 'voice-playback-error';
  const playback = Promise.withResolvers<void>();
  vi.mocked(HTMLMediaElement.prototype.play).mockReturnValue(playback.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => {
    host.querySelector('button')?.click();
    await vi.waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
  });
  await act(async () => {
    playback.reject(new Error('Media playback blocked'));
  });
  expect(current.state).toBe('error');
  expect(current.activeMessageId).toBe(messageId);
});

it('resolves the current voice again when replaying the same message after a new choice was saved', async () => {
  await renderAndPlay('voice-replay');
  await act(async () => current.stop());
  selected = 'new';
  await act(async () => {
    host.querySelector('button')?.click();
    await vi.waitFor(() => expect(played.length).toBe(2));
  });
  const requests = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/tts/listen/stream');
  expect(requests).toHaveLength(2);
  expect(JSON.parse(String(requests[1][1]?.body))).toEqual({
    catId: 'codex61-sol',
    text: '同一消息。',
    purpose: 'read-aloud',
  });
  expect(played[1]).not.toBe(played[0]);
  expect(useToastStore.getState().toasts.map((toast) => toast.message)).not.toContain(warning);
});

it('does not replace a new replay with an old audio download that finishes after stop', async () => {
  messageId = 'voice-replay-race';
  let release: ((response: Response) => void) | undefined;
  const previous = vi.mocked(apiFetch).getMockImplementation();
  if (!previous) throw new Error('API fixture unavailable');
  vi.mocked(apiFetch).mockImplementation((path, init) =>
    path.endsWith(`${messageId}-old.wav`)
      ? new Promise((resolve) => {
          release = resolve;
        })
      : previous(path, init),
  );
  await act(async () => root.render(<Harness />));
  await act(async () => {
    host.querySelector('button')?.click();
    await vi.waitFor(() => expect(release).toBeDefined());
  });
  await act(async () => current.stop());
  selected = 'new';
  await act(async () => {
    host.querySelector('button')?.click();
    await vi.waitFor(() => expect(played).toHaveLength(1));
  });
  await act(async () => {
    release?.(new Response('old audio'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(played).toHaveLength(1);
});

it('starts the first complete sentence before the read-aloud stream ends and cancels playback on stop', async () => {
  messageId = 'first-sentence';
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let requestSignal: AbortSignal | null | undefined;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path !== '/api/tts/listen/stream') return new Response('audio');
    requestSignal = init?.signal;
    return new Response(readable);
  });
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      host.querySelector('button')?.click();
      await vi.waitFor(() => expect(requestSignal).toBeDefined());
      await writer.write(encoder.encode(assetEvent('first')));
      await vi.waitFor(() => expect(played).toHaveLength(1));
    });
    expect(current.state).toBe('playing');
    await act(async () => current.stop());
    expect(requestSignal?.aborted).toBe(true);
    expect(current.state).toBe('idle');
    expect(played).toHaveLength(1);
  } finally {
    void writer.abort().catch(() => undefined);
  }
});
