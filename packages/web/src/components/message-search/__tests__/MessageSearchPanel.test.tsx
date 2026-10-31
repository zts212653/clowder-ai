import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { MessageSearchPanel } from '../MessageSearchPanel';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const emptyAnswer = {
  searchId: 'current-query',
  query: '琴键',
  results: [],
  meta: {
    scope: 'thread',
    sort: 'time',
    effectiveMode: 'hybrid',
    degraded: false,
    freshness: 'unknown',
    sourceCoverage: 'unknown',
    response: { truncated: false },
  },
};
describe('message lookup panel interaction', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => emptyAnswer } as Response);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  async function mount() {
    const close = vi.fn();
    const navigate = vi.fn();
    await act(async () => root.render(<MessageSearchPanel threadId="current" onClose={close} onNavigate={navigate} />));
    return { close, navigate, input: host.querySelector<HTMLInputElement>('input')! };
  }
  async function type(input: HTMLInputElement, text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  }
  it('focuses search and defaults to the current scope without starting navigation', async () => {
    const { input, navigate } = await mount();
    expect(document.activeElement).toBe(input);
    await type(input, '琴键');
    await submit();
    expect(apiFetch).toHaveBeenCalledOnce();
    const url = new URL(vi.mocked(apiFetch).mock.calls[0][0], 'https://example.test');
    expect(url.searchParams.get('threadId')).toBe('current');
    expect(navigate).not.toHaveBeenCalled();
    expect(host.textContent).toContain('本次检索未找到');
  });
  it('scope change reuses the entered query with the canonical service', async () => {
    const { input } = await mount();
    await type(input, '琴键');
    await submit();
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '全局')!.click());
    expect(apiFetch).toHaveBeenCalledTimes(2);
    const url = new URL(vi.mocked(apiFetch).mock.calls[1][0], 'https://example.test');
    expect(url.searchParams.get('q')).toBe('琴键');
    expect(url.searchParams.has('threadId')).toBe(false);
  });
  it('IME Enter does not query, and IME Escape does not close the panel', async () => {
    const { input, close } = await mount();
    await type(input, '琴键');
    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await submit();
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', isComposing: true })));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await submit();
    expect(apiFetch).toHaveBeenCalledOnce();
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })));
    expect(close).toHaveBeenCalledOnce();
  });
});
