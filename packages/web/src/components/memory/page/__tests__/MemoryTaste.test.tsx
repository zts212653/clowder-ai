import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryTaste } from '../MemoryTaste';

const fetchMock = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetchMock }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ nickname: '砚砚' }) }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span>头像</span> }));
vi.mock('@/hooks/useTeleport', () => ({
  handleTeleportEvent: (
    data: { threadId: string },
    _current: unknown,
    actions: { pushThreadRoute: (id: string) => void },
  ) => actions.pushThreadRoute(data.threadId),
}));
const entry = {
  id: 'taste-abcdef',
  revision: 'sha256:revision',
  visibility: 'public',
  title: '先看真实界面，再判断设计',
  when: '2026-09-25',
  quotes: ['先把真实东西摆出来'],
  scene: '在设计讨论里看界面',
  takeaway: '先看真实界面，再判断设计',
  dimension: 'visual-quality',
  tags: ['真实'],
  catId: 'codex61-sol',
  recall: {
    namedDelivery: { counts: { presented: 5, drilled: 2, applied: 1, dismissed: 1 } },
    search: { hits: 14, opened: 2, unverified: 1 },
  },
};
const original = {
  ...entry,
  title: '"先把真实东西摆出来"',
  quotes: ['"先把真实东西摆出来"'],
  takeaway: null,
  scene: '设计讨论时先展示实物',
};
const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  fetchMock.mockImplementation((url: string) =>
    url === '/api/memory/taste'
      ? ok({ readStatus: 'ready', entries: [entry], coverage: { unverified: 1 } })
      : url.includes('/source?')
        ? ok({ status: 'ready', canOpen: true, title: '设计讨论', threadId: 'thread-owner', messageId: 'm-owner' })
        : ok(entry),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
async function render() {
  await act(async () => root.render(<MemoryTaste />));
}
async function select() {
  const card = host.querySelector<HTMLButtonElement>('[data-testid="taste-card"] button');
  await act(async () => card?.click());
}
it('browses real memories, collapses the dome on selection, distinguishes hypotheses and absent candidate writers', async () => {
  await render();
  expect(host.textContent).toContain('品味 1');
  expect(host.textContent).toContain('画像 · 还没接进来');
  expect(host.querySelector('[data-testid="taste-dome"]')?.getAttribute('data-expanded')).toBe('true');
  await select();
  expect(host.querySelector('[data-testid="taste-dome"]')?.getAttribute('data-expanded')).toBe('false');
  expect(host.textContent).toContain('已有的做法假设');
  expect(host.textContent).toContain('概括候选尚未接入');
  expect(host.textContent).toContain('明确不用 1');
  expect(host.textContent).not.toContain('忽略');
  for (const name of ['确认这句', '修改', '忘掉'])
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === name)?.disabled).toBe(true);
});
it('verified source opens the actual chat route, while unavailable/missing source has no link', async () => {
  await render();
  await select();
  const open = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '查看原消息');
  expect(open?.querySelector('svg')).not.toBeNull();
  await act(async () => open?.click());
  expect(push).toHaveBeenCalledWith('/thread/thread-owner');
});
it.each([
  'not_recorded',
  'unavailable',
])('%s provenance stays distinct and never creates a navigation action', async (status) => {
  fetchMock.mockImplementation((url: string) =>
    url === '/api/memory/taste'
      ? ok({ readStatus: 'ready', entries: [entry] })
      : url.includes('/source?')
        ? ok({ status, canOpen: false, title: null })
        : ok(entry),
  );
  await render();
  await select();
  expect(host.textContent).toContain(status === 'not_recorded' ? '原始对话没有记录下来' : '暂时读不到出处对话');
  expect(host.textContent).not.toContain('查看原消息');
});
it('partial statistics stay unknown, absent channels are not zero, IDs are never rendered', async () => {
  const e = { ...entry, recall: null };
  fetchMock.mockImplementation((url: string) =>
    url === '/api/memory/taste'
      ? ok({ readStatus: 'partial', entries: [e], coverage: null })
      : url.includes('/source?')
        ? ok({ status: 'not_recorded', canOpen: false, title: null })
        : ok(e),
  );
  await render();
  await select();
  expect(host.textContent).toContain('部分读到');
  expect(host.textContent).toContain('暂时读不到被想起记录');
  expect(host.textContent).not.toContain('检索命中 0');
  expect(host.textContent).not.toContain('taste-abcdef');
  expect(host.textContent).not.toContain('sha256:');
});
it.each(['loading', 'empty', 'error'])('renders %s without fake counts', async (state) => {
  fetchMock.mockImplementation(() =>
    state === 'loading'
      ? new Promise(() => {})
      : state === 'error'
        ? Promise.resolve({ ok: false })
        : ok({ readStatus: 'ready', entries: [] }),
  );
  await render();
  expect(host.textContent).toContain(
    state === 'loading' ? '正在读取品味' : state === 'error' ? '暂时读不到品味' : '还没有品味',
  );
  if (state !== 'empty') expect(host.textContent).not.toContain('品味 0');
});
it('a malformed successful response is an unavailable read, not an empty taste collection', async () => {
  fetchMock.mockImplementation(() => ok({ events: [], meta: { hasMore: false } }));
  await render();
  expect(host.textContent).toContain('暂时读不到品味');
  expect(host.textContent).not.toContain('品味 0');
});
it('a malformed detail stays recoverable without crashing the surrounding memory page', async () => {
  fetchMock.mockImplementation((url: string) =>
    url === '/api/memory/taste'
      ? ok({ readStatus: 'ready', entries: [entry] })
      : url.includes('/source?')
        ? ok({ status: 'not_recorded', canOpen: false, title: null })
        : ok({ id: 'x' }),
  );
  await render();
  await select();
  expect(host.textContent).toContain('暂时读不到这条品味');
  expect(host.querySelector('[data-testid="taste-card"]')).not.toBeNull();
  fetchMock.mockImplementation((url: string) =>
    url.includes('/source?') ? ok({ status: 'not_recorded', canOpen: false, title: null }) : ok(entry),
  );
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '重试')?.click());
  expect(host.querySelector('aside h3')?.textContent).toBe(entry.takeaway);
});
it('a malformed source can be retried and cannot create a navigation action', async () => {
  fetchMock.mockImplementation((url: string) =>
    url === '/api/memory/taste'
      ? ok({ readStatus: 'ready', entries: [entry] })
      : url.includes('/source?')
        ? ok({ status: 'ready', canOpen: true, title: { invalid: true } })
        : ok(entry),
  );
  await render();
  await select();
  expect(host.textContent).toContain('暂时读不到出处');
  expect(host.textContent).not.toContain('查看原消息');
  fetchMock.mockImplementation(() =>
    ok({ status: 'ready', canOpen: true, title: '设计讨论', threadId: 'thread-owner', messageId: 'm-owner' }),
  );
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '重读出处')?.click());
  expect(host.textContent).toContain('查看原消息');
});
it('a source response lacking an exact message coordinate never displays an open action', async () => {
  fetchMock.mockImplementation((url: string) =>
    url === '/api/memory/taste'
      ? ok({ readStatus: 'ready', entries: [entry] })
      : url.includes('/source?')
        ? ok({ status: 'ready', canOpen: true, title: '设计讨论', threadId: 'thread-owner' })
        : ok(entry),
  );
  await render();
  await select();
  expect(host.textContent).not.toContain('查看原消息');
});
it('selecting a scrolled desktop card reveals its inspector and returning restores the list position', async () => {
  const main = document.createElement('main');
  document.body.append(main);
  main.append(host);
  await render();
  main.scrollTop = 700;
  await select();
  expect(main.scrollTop).toBe(0);
  const back = [...host.querySelectorAll('button')].find((button) => button.textContent === '返回全部');
  await act(async () => back?.click());
  expect(main.scrollTop).toBe(700);
  main.replaceWith(host);
});
it('zero channel counts are absence of channel records, while unverified retrieval stays visible', async () => {
  const e = {
    ...entry,
    recall: {
      namedDelivery: { counts: { presented: 0, drilled: 0, applied: 0, dismissed: 0 } },
      search: { hits: 0, opened: 0, unverified: 2 },
    },
  };
  fetchMock.mockImplementation((url: string) =>
    url === '/api/memory/taste'
      ? ok({ readStatus: 'ready', entries: [e] })
      : url.includes('/source?')
        ? ok({ status: 'not_recorded', canOpen: false, title: null })
        : ok(e),
  );
  await render();
  await select();
  expect(host.textContent).not.toContain('已递送 0');
  expect(host.textContent).not.toContain('命中 0');
  expect(host.textContent).toContain('2 次归属没核实');
  expect(host.textContent).toContain('这条渠道没有记录');
});
it('an original-only memory shows its scene on the card and does not repeat the quote below the detail title', async () => {
  fetchMock.mockImplementation((url: string) =>
    url === '/api/memory/taste'
      ? ok({ readStatus: 'ready', entries: [original] })
      : url.includes('/source?')
        ? ok({ status: 'not_recorded', canOpen: false, title: null })
        : ok(original),
  );
  await render();
  const card = host.querySelector('[data-testid="taste-card"]');
  expect(card?.textContent).toContain('设计讨论时先展示实物');
  expect(card?.textContent?.match(/先把真实东西摆出来/g)).toHaveLength(1);
  await select();
  const detail = host.querySelector('aside[aria-label="品味详情"]');
  expect(detail?.textContent).toContain('原话 · 还没有做法假设');
  expect(detail?.textContent?.match(/先把真实东西摆出来/g)).toHaveLength(1);
  expect([...(detail?.querySelectorAll('h4') ?? [])].some((h) => h.textContent === '原话')).toBe(false);
  expect(detail?.textContent).not.toContain('“"');
});
it('quote framing unwraps original punctuation while a hypothesis keeps the original quote beneath it', async () => {
  const e = { ...entry, quotes: ['“"先把真实东西摆出来"”'] };
  fetchMock.mockImplementation((url: string) =>
    url === '/api/memory/taste'
      ? ok({ readStatus: 'ready', entries: [e] })
      : url.includes('/source?')
        ? ok({ status: 'not_recorded', canOpen: false, title: null })
        : ok(e),
  );
  await render();
  expect(host.querySelector('[data-testid="taste-card"]')?.textContent).toContain('“先把真实东西摆出来”');
  expect(host.textContent).not.toContain('““');
  await select();
  expect(host.querySelector('aside h4')?.textContent).toBe('原话');
});
it('both metadata and approval use the verified proposal instant in local time with no seconds', async () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  const year = new Date().getFullYear();
  const e = {
    ...original,
    when: `${year}-08-26`,
    approval: {
      status: 'approved',
      proposedAt: Date.parse(`${year}-08-26T03:26:25Z`),
      approvedAt: Date.parse(`${year}-08-26T03:26:36Z`),
    },
  };
  fetchMock.mockImplementation((url: string) =>
    url === '/api/memory/taste'
      ? ok({ readStatus: 'ready', entries: [e] })
      : url.includes('/source?')
        ? ok({ status: 'not_recorded', canOpen: false, title: null })
        : ok(e),
  );
  await render();
  expect(host.querySelector('time')?.textContent).toBe('8月25日 20:26');
  await select();
  const detail = host.querySelector('aside');
  expect(detail?.querySelector('time')?.textContent).toBe('8月25日 20:26');
  expect(detail?.textContent).toContain('提出于 8月25日 20:26');
  expect(detail?.textContent).toContain('已批准 · 8月25日 20:26');
  expect(detail?.textContent).not.toContain('20:26:');
  vi.unstubAllEnvs();
});
it('a date-only legacy record has no invented local proposal instant', async () => {
  await render();
  expect(host.querySelector('time')?.textContent).toContain('记录日期');
  expect(host.querySelector('time')?.textContent).toContain('提出时间没有记录下来');
});
