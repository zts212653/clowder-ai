import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startMessageReadingSession } from '@/components/message-search/message-reading-session';
import { MemoryNavigation } from '../MemoryNavigation';

vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => false }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
it('only a matching original J5 find session changes the memory back link', async () => {
  const session = startMessageReadingSession(
    {
      searchId: 'find',
      origin: { threadId: 'origin', readingRef: 'original-owner' },
      targets: [],
      generation: 0,
      settledIndex: null,
      pending: null,
      status: 'ready',
    },
    true,
    {
      destination: 'memory',
      state: { query: '一行', scope: 'global', sort: 'time', scrollTop: 214, status: 'idle' },
    },
  ).session;
  await act(async () => root.render(<MemoryNavigation from="origin" findSessionId={session.id} />));
  const back = host.querySelector('a');
  expect(back?.textContent).toBe('‹ 回到查找');
  expect(back?.getAttribute('href')).toBe(`/thread/origin?findReturn=${session.id}`);
  await act(async () => root.render(<MemoryNavigation from="other" findSessionId={session.id} />));
  expect(host.querySelector('a')?.textContent).toBe('返回对话');
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/thread/other');
});
it('keeps ordinary and unknown-origin memory visits on the original conversation return', async () => {
  await act(async () => root.render(<MemoryNavigation from="origin" findSessionId="unrecognized" />));
  expect(host.querySelector('a')?.textContent).toBe('返回对话');
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/thread/origin');
});
