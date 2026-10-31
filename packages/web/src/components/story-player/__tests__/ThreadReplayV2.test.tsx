import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TheaterReplayContent } from '../TheaterReplayContent';

const { source, actions } = vi.hoisted(() => ({
  source: { presentation: 'v2', loading: false, error: null as string | null, total: 3, mode: 'cinematic' },
  actions: {
    play: vi.fn(),
    seek: vi.fn(),
    speed: vi.fn(),
    mode: vi.fn(),
    adaptive: vi.fn(),
    forward: vi.fn(),
    backward: vi.fn(),
  },
}));

vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => source.presentation }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => ({ id, displayName: '缅因猫 Sol', color: { primary: '#4f875a' } }),
  }),
  formatCatName: (cat: { displayName: string }) => cat.displayName,
}));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span data-testid="avatar" /> }));
vi.mock('@/components/CollapsibleMarkdown', () => ({
  CollapsibleMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock('@/components/ThinkingContent', () => ({
  ThinkingContent: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock('@/components/cli-output/CliOutputBlock', () => ({ CliOutputBlock: () => <div>原工具记录</div> }));
vi.mock('@/lib/story-player/useThreadReplay', () => ({
  useThreadReplay: () => ({
    isLoading: source.loading,
    error: source.error,
    engine: {
      state: 'paused',
      speed: 10,
      currentIndex: 1,
      totalEvents: source.total,
      elapsedMs: 1000,
      totalDurationMs: 721000,
      displayMode: source.mode,
      adaptivePacing: true,
      bulletTime: null,
    },
    events: source.total
      ? [
          { index: 0, eventNo: 0, type: 'message', role: 'user', timestamp: 1000, content: '用户原话' },
          {
            index: 1,
            eventNo: 1,
            type: 'message',
            role: 'assistant',
            catId: 'codex61-sol',
            timestamp: 2000,
            content: '原回复',
          },
          {
            index: 2,
            eventNo: 2,
            type: 'message',
            role: 'assistant',
            catId: 'codex61-sol',
            timestamp: 722000,
            content: '空闲后回复',
            idleSkipMs: 720000,
          },
        ]
      : [],
    messages: source.total
      ? [
          { id: 'replay_0', type: 'user', timestamp: 1000, content: '用户原话', isStreaming: false },
          {
            id: 'replay_1',
            type: 'assistant',
            catId: 'codex61-sol',
            timestamp: 2000,
            content: '原回复',
            thinking: '原思考',
            toolEvents: [{ id: 'tool1', name: 'Read', status: 'completed' }],
            isStreaming: false,
          },
        ]
      : [],
    chapters: source.total
      ? [
          { kind: 'session_start', label: 'Session Start', eventIndex: 0, timestamp: 1000 },
          { kind: 'invocation', label: 'Invocation child-1', eventIndex: 1, timestamp: 2000 },
        ]
      : [],
    densityBuckets: [],
    activeSkip: null,
    togglePlayPause: actions.play,
    doSeek: actions.seek,
    doSetSpeed: actions.speed,
    doStepForward: actions.forward,
    doStepBackward: actions.backward,
    doToggleDisplayMode: actions.mode,
    doToggleAdaptivePacing: actions.adaptive,
  }),
}));

let container: HTMLDivElement;
let root: Root;
const render = () => act(() => root.render(<TheaterReplayContent threadId="real-thread" />));
function button(name: string | RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) => {
    const label = item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  expect(found, `button ${String(name)}`).toBeDefined();
  return found!;
}
function required<T extends Element>(selector: string): T {
  const found = container.querySelector<T>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
}
function change(item: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const prototype = item instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(item, value);
    item.dispatchEvent(new Event(item instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }));
  });
}
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(source, { presentation: 'v2', loading: false, error: null, total: 3, mode: 'cinematic' });
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

describe('thread replay v2 consumes the original replay owner', () => {
  it('plays, seeks, sets the original speed and toggles pacing/display mode through the owner', () => {
    render();
    act(() => button('播放回放').click());
    expect(actions.play).toHaveBeenCalledOnce();
    change(required<HTMLInputElement>('input[aria-label="回放进度"]'), '2');
    expect(actions.seek).toHaveBeenCalledWith(2);
    change(required<HTMLSelectElement>('select[aria-label="播放速度"]'), 'max');
    expect(actions.speed).toHaveBeenCalledWith('max');
    act(() => button(/跳过空闲/).click());
    expect(actions.adaptive).toHaveBeenCalledOnce();
    act(() => button('保真').click());
    expect(actions.mode).toHaveBeenCalledOnce();
  });

  it('keeps real reply/tool content, uses the chat nameplate and hides thinking only in cinematic mode', () => {
    render();
    expect(required('[data-testid="cat-nameplate"]').getAttribute('data-cat-id')).toBe('codex61-sol');
    expect(container.textContent).toContain('用户原话');
    expect(container.textContent).toContain('原回复');
    expect(container.textContent).toContain('原工具记录');
    expect(container.textContent).not.toContain('原思考');
    source.mode = 'faithful';
    render();
    expect(container.textContent).toContain('原思考');
  });

  it('keeps chapter navigation and event stepping on the original owner with Chinese controls', () => {
    render();
    act(() => button('上一个事件').click());
    expect(actions.backward).toHaveBeenCalledOnce();
    act(() => button('下一个事件').click());
    expect(actions.forward).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('Session Start');
    expect(container.textContent).not.toContain('Invocation child-1');
    act(() => button('0:01 · 新一轮').click());
    expect(actions.seek).toHaveBeenCalledWith(1);
  });

  it('exposes the owner loading/error/empty states without inventing playback or events', () => {
    source.loading = true;
    render();
    expect(container.textContent).toContain('正在读取回放…');
    source.loading = false;
    source.error = '403 Forbidden';
    render();
    expect(container.textContent).toContain('回放暂不可用');
    expect(container.textContent).toContain('403 Forbidden');
    source.error = null;
    source.total = 0;
    render();
    expect(container.textContent).toContain('暂无可回放的记录');
    expect(button('播放回放').disabled).toBe(true);
    expect(required<HTMLInputElement>('input[aria-label="回放进度"]').disabled).toBe(true);
  });

  it('leaves the classic presentation on its original controls and message renderer', () => {
    source.presentation = 'classic';
    render();
    expect(button('Play')).toBeDefined();
    expect(container.querySelector('[data-testid="thread-replay-v2"]')).toBeNull();
    expect(container.querySelector('[data-testid="cat-nameplate"]')).toBeNull();
  });
});
