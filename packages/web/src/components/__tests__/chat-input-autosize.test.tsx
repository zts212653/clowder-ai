import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(async () => new Response('{}')) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('@/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', transcript: '', partialTranscript: '', error: null, duration: 0 }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom has no layout. Model the measured Windows box: 20px line, 24px padding, 2px border.
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLTextAreaElement,
  ) {
    return this.value.split('\n').length * 20 + 24;
  });
  vi.spyOn(HTMLTextAreaElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLTextAreaElement,
  ) {
    return this.style.height === 'auto' ? 46 : Number.parseFloat(this.style.height) || 46;
  });
  vi.spyOn(HTMLTextAreaElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLTextAreaElement,
  ) {
    return this.offsetHeight - 2;
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(presentation: 'classic' | 'v2' = 'v2', placeholder?: string) {
  act(() => root.render(<ChatInput onSend={vi.fn()} presentation={presentation} placeholder={placeholder} />));
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

function type(textarea: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ChatInput border-box autosizing', () => {
  it.each(['classic', 'v2'] as const)('does not overflow when %s input is empty', (presentation) => {
    const textarea = render(presentation);
    expect(textarea.value).toBe('');
    expect(textarea.clientHeight).toBeGreaterThanOrEqual(textarea.scrollHeight);
    expect(textarea.style.height).toBe('46px');
  });

  it('fits a single line without a scrollbar', () => {
    const textarea = render();
    type(textarea, 'Windows 输入框');
    expect(textarea.value).toBe('Windows 输入框');
    expect(textarea.clientHeight).toBeGreaterThanOrEqual(textarea.scrollHeight);
  });

  it('grows for multiple lines and shrinks back when cleared', () => {
    const textarea = render();
    type(textarea, '第一行\n第二行\n第三行');
    expect(textarea.style.height).toBe('86px');
    expect(textarea.clientHeight).toBe(textarea.scrollHeight);
    type(textarea, '');
    expect(textarea.style.height).toBe('46px');
    expect(textarea.clientHeight).toBe(textarea.scrollHeight);
  });

  it('remeasures when the displayed placeholder changes without a draft or width change', () => {
    const textarea = render('classic', '短提示');
    expect(textarea.style.height).toBe('46px');
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(64);
    render('classic', '想调整方向？可直接给当前成员发消息，引导回复。');
    expect(textarea.value).toBe('');
    expect(textarea.placeholder).toContain('引导回复');
    expect(textarea.style.height).toBe('66px');
    expect(textarea.clientHeight).toBeGreaterThanOrEqual(textarea.scrollHeight);
  });

  it('remeasures an empty placeholder when viewport width changes', () => {
    const textarea = render();
    // At 390px the production placeholder wraps to two lines without changing the input value.
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(64);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(textarea.value).toBe('');
    expect(textarea.style.height).toBe('66px');
    expect(textarea.clientHeight).toBe(textarea.scrollHeight);
  });

  it('remeasures pane width changes without reacting to height-only notifications', () => {
    let notify: ResizeObserverCallback = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notify = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const textarea = render();
    expect(observe).toHaveBeenCalledWith(textarea.parentElement);
    const changeWidth = (width: number) =>
      act(() => notify([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(64);
    changeWidth(240);
    expect(textarea.style.height).toBe('66px');
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(84);
    changeWidth(240);
    expect(textarea.style.height).toBe('66px');
    changeWidth(160);
    expect(textarea.style.height).toBe('86px');
    type(textarea, '新草稿');
    expect(disconnect).toHaveBeenCalled();
  });

  it.each([
    [false, 200],
    [true, 120],
  ])('keeps the height cap and overflow for long text (mobile=%s)', (mobile, maxHeight) => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: mobile })),
    );
    const textarea = render();
    type(textarea, Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行`).join('\n'));
    expect(textarea.style.height).toBe(`${maxHeight}px`);
    expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
  });
});
