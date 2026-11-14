import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecallEvent } from '@/hooks/recall-types';
import { apiFetch } from '@/utils/api-client';
import { MatterRecallLine } from '../MatterRecallLine';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ displayName: '小太阳' }) }) }));
const event: RecallEvent = {
  id: 'read',
  cueId: 'cue',
  invocationId: 'invocation',
  catId: 'sonnet',
  query: '',
  timestamp: 1,
  source: 'pull',
  cueStatus: 'drilled',
  resolverFamily: 'matter',
  matterRead: { status: 'current', matterId: 'matter', title: 'Settings', messageCount: 1 },
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 'current',
        page: {
          matter: { matterId: 'matter', revision: 2, description: '仅社区管理线程：先判断必要性，再合法派发。' },
          entries: [
            {
              entryId: 'entry',
              quote: 'Original decision',
              attribution: 'author',
              source: { threadId: 'source', messageId: 'message', timestamp: 1, author: { kind: 'user' } },
            },
          ],
        },
      }),
    ),
  );
});
it('shows the receipt version interpretation before its original speech and keeps source attribution', async () => {
  await act(async () => root.render(<MatterRecallLine event={event} threadId="thread" />));
  await act(async () => container.querySelector('button')!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('猫的归纳（非原话）');
  expect(dialog.textContent).toContain('第 2 版');
  expect(dialog.textContent).toContain('仅社区管理线程：先判断必要性，再合法派发。');
  expect(dialog.textContent!.indexOf('仅社区管理线程')).toBeLessThan(dialog.textContent!.indexOf('Original decision'));
  expect(dialog.textContent).toContain('你');
  expect(dialog.querySelector('a[href="/thread/source?message=message"]')).not.toBeNull();
  expect([...dialog.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toContain(
    '/memory?matter=matter&from=thread',
  );
});
it('gives an honest empty interpretation and distinguishes a verified quoted speaker from the outer author', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 'current',
        page: {
          matter: { matterId: 'matter', revision: 3, description: '' },
          entries: [
            {
              entryId: 'quoted',
              quote: 'Quoted words',
              attribution: 'quoted_in_message',
              verifiedQuotedAuthor: { kind: 'agent', catId: 'codex61-sol' },
              source: { threadId: 'source', messageId: 'message', timestamp: 1, author: { kind: 'user' } },
            },
          ],
        },
      }),
    ),
  );
  await act(async () => root.render(<MatterRecallLine event={event} threadId="thread" />));
  await act(async () => container.querySelector('button')!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('这次读取没有附语境说明');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('小太阳 · 引自原消息');
});
it.each([
  'changed',
  'not_available',
] as const)('never substitutes a new interpretation for a %s receipt', async (status) => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ status })));
  await act(async () => root.render(<MatterRecallLine event={event} threadId="thread" />));
  await act(async () => container.querySelector('button')!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain(status === 'changed' ? '来源已更正' : '来源已不可用');
  expect(dialog.textContent).not.toContain('仅社区管理线程');
  expect(dialog.querySelector('blockquote')).toBeNull();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});
it('keeps an open source popover through a refreshed copy of the same persisted read', async () => {
  await act(async () => root.render(<MatterRecallLine event={event} threadId="thread" />));
  await act(async () => container.querySelector('button')!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original decision');
  await act(async () =>
    root.render(<MatterRecallLine event={{ ...event, matterRead: { ...event.matterRead! } }} threadId="thread" />),
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original decision');
  await act(async () =>
    root.render(
      <MatterRecallLine
        event={{ ...event, matterRead: { status: 'changed', matterId: 'matter' } }}
        threadId="thread"
      />,
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain('参考资料已更正');
});
