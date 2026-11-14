import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MemoryPage from '@/app/memory/page';
import { readMemorySourceTarget } from '../memory-source-target';
import { tasteEntry } from './recall-page-fixture';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetch }));
vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => 'v2' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => null }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
const revision = `sha256:${'a'.repeat(64)}`;
const response = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });
const taste = {
  ...tasteEntry(`taste-${'a'.repeat(24)}`, 2),
  revision,
  status: 'active',
  takeaway: '先验证实际结果',
  when: '2026-11-09',
};
const person = {
  personId: 'person_source',
  personRevision: `sha256:${'b'.repeat(64)}`,
  displayName: '虚构小林',
  aliases: [],
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  sourceCount: 1,
  claims: [],
  relationships: [],
  interactions: [],
  truncation: { claims: false, relationships: false, interactions: false },
};
const event = {
  eventId: 'evt_source',
  ownerUserId: 'owner',
  revision,
  status: 'active',
  timestamp: 1,
  threadId: 'source-thread',
  messageId: 'source-message',
  type: '第一性原理',
  trigger: 'human_brake',
  cat: 'sonnet',
  summary: '先看完整目标',
  cognitiveTransition: 'scope_correction',
  relatedHarness: null,
  confidence: 'high',
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  fetch.mockImplementation((path: string) =>
    path.includes('/source?')
      ? response({ status: 'unavailable', sources: [], title: null, canOpen: false })
      : path.startsWith('/api/memory/taste/')
        ? response(taste)
        : path.startsWith('/api/memory/people/')
          ? response(person)
          : path.startsWith('/api/memory/events/')
            ? response(event)
            : response({}),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
async function open(family: string, memoryId: string) {
  await act(async () =>
    root.render(<MemoryPage searchParams={{ family, memoryId, revision, from: 'source-thread' }} />),
  );
}
it.each([
  ['taste', taste.id, '品味详情', taste.takeaway],
  ['person', person.personId, '人物详情', person.displayName],
  ['event', event.eventId, '事件详情', event.summary],
])('opens a delivered %s through its version-bound original lane', async (family, id, label, text) => {
  await open(family, id);
  expect(host.querySelector(`aside[aria-label="${label}"]`)).not.toBeNull();
  expect(host.textContent).toContain(text);
  const paths = fetch.mock.calls.map(([path]) => String(path));
  expect(
    paths.some((path) =>
      path.includes(`${family === 'person' ? 'deliveryRevision' : 'revision'}=${encodeURIComponent(revision)}`),
    ),
  ).toBe(true);
  expect(host.querySelector('a[aria-label="返回原对话"]')?.getAttribute('href')).toBe('/thread/source-thread');
});
it.each([409, 404, 403])('does not render current content on a rejected delivered version (%s)', async (status) => {
  fetch.mockImplementation((path: string) =>
    path.startsWith('/api/memory/taste/') ? response(taste, status) : response({}),
  );
  await open('taste', taste.id);
  expect(host.querySelector('aside[aria-label="品味详情"]')).toBeNull();
  expect(host.textContent).not.toContain(taste.takeaway);
  expect(host.textContent).toContain(status === 409 ? '这条记忆在递来之后改过' : '这条记忆暂时读不到');
  expect(host.textContent).toContain('查看品味列表');
});
it('disables event editing when the original message is unreadable without hiding the readable memory', async () => {
  await open('event', event.eventId);
  const buttons = [...host.querySelectorAll('button')];
  expect(buttons.find((button) => button.textContent === '编辑')?.disabled).toBe(true);
  expect(buttons.find((button) => button.textContent === '不再使用')?.disabled).toBe(false);
  expect(buttons.find((button) => button.textContent === '忘掉事件')?.disabled).toBe(false);
  expect(host.textContent).toContain('来源读不到，暂时不能编辑');
  expect(host.textContent).toContain(event.summary);
});
it('rejects malformed memory targets before reading an unrelated current detail', () => {
  for (const family of ['taste', 'person', 'event'])
    expect(readMemorySourceTarget({ family, memoryId: '../private', revision })).toEqual({ status: 'invalid' });
  expect(readMemorySourceTarget({ family: 'person', memoryId: 'person_source', revision })).toMatchObject({
    status: 'ready',
  });
  expect(readMemorySourceTarget({ family: 'taste', memoryId: taste.id })).toMatchObject({ status: 'ready' });
  for (const revision of ['', 'bad', ['sha256:invalid']])
    expect(readMemorySourceTarget({ family: 'taste', memoryId: taste.id, revision })).toEqual({ status: 'invalid' });
});

it('rejects an event body whose revision differs from the requested delivery even on HTTP 200', async () => {
  fetch.mockImplementation((path: string) =>
    path.startsWith('/api/memory/events/')
      ? response({ ...event, revision: `sha256:${'c'.repeat(64)}` })
      : response({}),
  );
  await open('event', event.eventId);
  expect(host.querySelector('aside[aria-label="事件详情"]')).toBeNull();
  expect(host.textContent).toContain('这条记忆在递来之后改过');
  expect(host.textContent).not.toContain(event.summary);
});

it('renders owner edits in the local source date format without an ISO timestamp', async () => {
  fetch.mockImplementation((path: string) =>
    path.includes('/source?')
      ? response({
          status: 'ready',
          sources: [{ kind: 'owner_action', label: '你在记忆页修改', occurredAt: 1760000000000, canOpen: false }],
        })
      : path.startsWith('/api/memory/people/')
        ? response(person)
        : response({}),
  );
  await open('person', person.personId);
  expect(host.textContent).toContain('你在记忆页修改 · ');
  expect(host.textContent).not.toContain('2025-10-09T');
  expect(host.textContent).not.toContain('.000Z');
});
