import type { MessageSearchResponse } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageSearchPanel } from '../MessageSearchPanel';

const fetchMock = vi.hoisted(() => vi.fn());
let shell = 'v2';
vi.mock('@/utils/api-client', () => ({ apiFetch: fetchMock }));
vi.mock('../../shell/shell-presentation', () => ({ useShellPresentation: () => shell }));
const response: MessageSearchResponse = {
  searchId: 'same-original-result',
  query: '一行',
  results: [],
  meta: {
    scope: 'global',
    sort: 'relevance',
    requestedMode: 'hybrid',
    effectiveMode: 'hybrid',
    degraded: false,
    partial: false,
    hasMore: false,
    candidateLimit: 100,
    semanticCandidatesLimited: false,
    sourceCoverage: 'unknown',
    freshness: 'unknown',
    response: { budgetChars: 24000, serializedChars: 500, truncated: false, continuation: 'unavailable' },
  },
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  shell = 'v2';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => response });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function button(label: string) {
  return [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
}
async function mount() {
  const open = vi.fn();
  await act(async () =>
    root.render(
      <MessageSearchPanel threadId="origin" onClose={vi.fn()} onNavigate={vi.fn()} onOpenDestination={open} />,
    ),
  );
  return open;
}
async function enterQuery() {
  const input = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '一行');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it.each([
  ['记忆 ↗', 'memory'],
  ['作品 ↗', 'works'],
] as const)('%s hands the same query and popover state to its existing owner without another message search', async (label, target) => {
  const open = await mount();
  await enterQuery();
  await act(async () => button('全局')!.click());
  await act(async () => button('按相关')!.click());
  const scroll = host.querySelector<HTMLElement>('[data-message-search-scroll]')!;
  scroll.scrollTop = 214;
  const count = fetchMock.mock.calls.length;
  expect(button(label)).toBeDefined();
  await act(async () => button(label)!.click());
  expect(open).toHaveBeenCalledWith(
    target,
    expect.objectContaining({ query: '一行', scope: 'global', sort: 'relevance', scrollTop: 214, response }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(count);
});

it('does not leave the current find session for an empty query', async () => {
  const open = await mount();
  expect(button('记忆 ↗')?.disabled).toBe(true);
  expect(button('作品 ↗')?.disabled).toBe(true);
  expect(open).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('keeps the classic scope row unchanged', async () => {
  shell = 'classic';
  await mount();
  expect(button('记忆 ↗')).toBeUndefined();
  expect(button('作品 ↗')).toBeUndefined();
});

it('reopens the same saved find result and popover position without requerying', async () => {
  await act(async () =>
    root.render(
      <MessageSearchPanel
        threadId="origin"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        initialState={{ query: '一行', scope: 'global', sort: 'relevance', scrollTop: 214, status: 'ready', response }}
      />,
    ),
  );
  expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('一行');
  expect(button('全局')?.getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector<HTMLElement>('[data-message-search-scroll]')?.scrollTop).toBe(214);
  expect(host.textContent).toContain('本次检索未找到');
  expect(fetchMock).not.toHaveBeenCalled();
});
