import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput, syncDraftToStorage } from '@/components/ChatInput';

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
  syncDraftToStorage('mirror-restored', undefined);
  syncDraftToStorage('mirror-other', undefined);
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
    const callbacks = new Map<Element, ResizeObserverCallback>();
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe = (element: Element) => {
          observe(element);
          callbacks.set(element, this.callback);
        };
        disconnect = disconnect;
      },
    );
    const textarea = render();
    expect(observe).toHaveBeenCalledWith(textarea.parentElement);
    const changeWidth = (width: number) =>
      act(() =>
        callbacks.get(textarea.parentElement!)!(
          [{ contentRect: { width } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
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

  it.each(
    [false, true].flatMap((mobile) =>
      ['短草稿', 'https://example.com/short', '长草稿\n'.repeat(26), 'https://example.com/long\n'.repeat(26)].map(
        (input) => ({ mobile, input }),
      ),
    ),
  )('synchronizes a stable draft after keyed remount (mobile=$mobile, input=$input)', ({ mobile, input }) => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: mobile })),
    );
    vi.spyOn(HTMLTextAreaElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
    const observe = vi.spyOn(ResizeObserver.prototype, 'observe');
    syncDraftToStorage('mirror-restored', input);
    const visit = (threadId: string) =>
      act(() => root.render(<ChatInput key={threadId} threadId={threadId} presentation="v2" onSend={vi.fn()} />));
    visit('mirror-restored');
    visit('mirror-other');
    visit('mirror-restored');

    const textarea = container.querySelector('textarea')!;
    const mirror = container.querySelector<HTMLElement>('[data-testid="composer-link-mirror"]')!;
    expect(textarea.value).toBe(input);
    expect(mirror.style.height).toBe(`${textarea.clientHeight}px`);
    expect(mirror.style.width).toBe(`${textarea.clientWidth}px`);
    expect(observe).toHaveBeenCalledWith(textarea);
    expect(mirror.textContent).toBe(input.endsWith('\n') ? `${input}\u200b` : input);
    const hasLink = input.includes('https://');
    expect(mirror.dataset.active).toBe(String(hasLink));
    expect(mirror.querySelector('mark') !== null).toBe(hasLink);

    act(() => {
      textarea.scrollTop = 75;
      textarea.dispatchEvent(new Event('scroll'));
    });
    expect(mirror.scrollTop).toBe(75);
    if (hasLink) {
      act(() => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
      expect(mirror.dataset.active).toBe('false');
      act(() => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
      expect(mirror.dataset.active).toBe('true');
    }
  });
});
