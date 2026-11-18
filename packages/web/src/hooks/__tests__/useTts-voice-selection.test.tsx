import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { type UseTtsReturn, useTts } from '../useTts';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/services/playbackRuntime', () => ({ peekPlaybackManager: () => null }));
let current: UseTtsReturn;
let host: HTMLDivElement;
let root: Root;
let messageId: string;
let selected: 'old' | 'new';
const played: string[] = [];
const warning = '未配置本人声线，本次使用全局默认声音。';
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
  vi.stubGlobal(
    'Audio',
    class {
      src: string;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(src: string) {
        this.src = src;
      }
      pause() {}
      async play() {
        played.push(this.src);
      }
    },
  );
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    path === '/api/tts/synthesize'
      ? Response.json({
          audioUrl: `/api/tts/audio/${messageId}-${selected}.wav`,
          voiceSelection: { warnings: selected === 'old' ? [warning] : [] },
        })
      : new Response('audio'),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => {
    current?.stop();
    root.unmount();
  });
  host.remove();
  vi.resetAllMocks();
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

it('resolves the current voice again when replaying the same message after a new choice was saved', async () => {
  await renderAndPlay('voice-replay');
  await act(async () => current.stop());
  selected = 'new';
  await act(async () => {
    host.querySelector('button')?.click();
    await vi.waitFor(() => expect(played.length).toBe(2));
  });
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/tts/synthesize')).toHaveLength(2);
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
