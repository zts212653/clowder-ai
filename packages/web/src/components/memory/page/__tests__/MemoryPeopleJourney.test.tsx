import { personForgetRequestIdSchema } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryTaste } from '../MemoryTaste';

const { apiFetch, push } = vi.hoisted(() => ({ apiFetch: vi.fn(), push: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => null }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
vi.mock('../MemoryTasteSky', () => ({ MemoryTasteSky: () => null }));
const person = {
  personId: 'person-a',
  displayName: '小林',
  aliases: ['林老师'],
  status: 'active',
  createdAt: 100,
  updatedAt: 200,
  currentClaimCount: 1,
  activeInteractionCount: 0,
  relationship: null,
  latestInteraction: null,
};
const claim = {
  claimId: 'claim-a',
  revision: 'claim-revision-1',
  payload: { kind: 'user_assessment', statement: '愿意听取不同意见', stance: 'endorsed', assertedBy: 'owner' },
  status: 'current',
  recordedAt: 100,
  sourceCount: 1,
};
const detail = {
  personId: person.personId,
  displayName: person.displayName,
  aliases: person.aliases,
  status: person.status,
  createdAt: person.createdAt,
  updatedAt: person.updatedAt,
  personRevision: 'person-revision-1',
  sourceCount: 1,
  claims: [claim],
  relationships: [],
  interactions: [],
  truncation: { claims: false, relationships: false, interactions: false },
};
const taste = {
  id: 'taste-a',
  revision: 'taste-rev',
  visibility: 'public',
  title: '先看实物',
  when: '2026-10-06',
  quotes: ['先展示实物'],
  scene: '一起看页面',
  takeaway: '先看实物',
  tags: [],
  dimension: null,
  catId: null,
  recall: null,
};
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
let host: HTMLDivElement;
let root: Root;
function button(text: string) {
  return [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
}
async function click(text: string) {
  expect(button(text), text).toBeDefined();
  await act(async () => button(text)?.click());
}
async function openPerson() {
  await act(async () => root.render(<MemoryTaste />));
  await click('人物');
  await click('小林');
}
function setText(selector: string, value: string) {
  const node = host.querySelector<HTMLTextAreaElement>(selector);
  expect(node).not.toBeNull();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(node, value);
  node?.dispatchEvent(new Event('input', { bubbles: true }));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apiFetch.mockImplementation(async (path: string) =>
    path === '/api/memory/taste'
      ? response({ readStatus: 'ready', entries: [taste], coverage: null })
      : path.includes('/source?')
        ? response({
            status: 'ready',
            sources: [{ kind: 'owner_action', label: '主人在记忆页操作 · 更正', occurredAt: 100, canOpen: false }],
          })
        : path.startsWith('/api/memory/people?')
          ? response({
              readStatus: 'ready',
              entries: [person],
              meta: { count: 1, limit: 20, offset: 0, hasMore: false },
            })
          : response(detail),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('reads owner people from the real family tab, preserving owner-action provenance without a fake chat jump or entry write', async () => {
  await openPerson();
  expect(host.textContent).toContain('愿意听取不同意见');
  expect(host.textContent).toContain('主人在记忆页操作 · 更正');
  expect(button('查看原消息')).toBeUndefined();
  expect(apiFetch.mock.calls.every((args: unknown[]) => args.length === 1)).toBe(true);
});
it('switches memory families without mixing taste cards or taste sorting into the people view', async () => {
  await act(async () => root.render(<MemoryTaste />));
  expect(host.querySelectorAll('[data-testid="taste-card"]')).toHaveLength(1);
  await click('人物');
  expect(host.querySelectorAll('[data-testid="taste-card"]')).toHaveLength(0);
  expect(host.querySelector('select[aria-label="品味排序"]')).toBeNull();
  expect(button('小林')).toBeDefined();
  await click('品味 1');
  expect(host.querySelectorAll('[data-testid="taste-card"]')).toHaveLength(1);
  expect(host.querySelector('section[aria-label="人物记忆"]')).toBeNull();
});
it('preserves loaded people when the next page fails and recovers without duplicating a person', async () => {
  let attempt = 0;
  apiFetch.mockImplementation(async (path: string) =>
    path === '/api/memory/taste'
      ? response({ readStatus: 'ready', entries: [], coverage: null })
      : path.includes('offset=0')
        ? response({
            readStatus: 'ready',
            entries: [person],
            meta: { count: 1, limit: 20, offset: 0, hasMore: true, nextOffset: 1 },
          })
        : ++attempt === 1
          ? response({ error: 'unavailable' }, 503)
          : response({
              readStatus: 'ready',
              entries: [person, { ...person, personId: 'person-b', displayName: '小周' }],
              meta: { count: 2, limit: 20, offset: 1, hasMore: false },
            }),
  );
  await act(async () => root.render(<MemoryTaste />));
  await click('人物');
  await click('读取更多人物');
  expect(button('小林')).toBeDefined();
  expect(host.textContent).toContain('较早的记录暂时读不到');
  await click('重试读取');
  expect(button('小周')).toBeDefined();
  expect([...host.querySelectorAll('button')].filter((node) => node.textContent === '小林')).toHaveLength(1);
});
it('amends an interaction using the exact revision and retains its recorded time and uncertainty', async () => {
  const interaction = {
    eventId: 'event-a',
    revision: 'event-revision-1',
    eventKind: 'meeting',
    headline: '谈论合作',
    status: 'active',
    recordedAt: 100,
    sourceCount: 1,
    importanceOrTopic: '合作方式',
    uncertaintyNotes: ['具体日期不确定'],
  };
  const original = apiFetch.getMockImplementation();
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? response({ action: 'amend_event', outcome: 'applied' })
      : path === '/api/memory/people/person-a'
        ? response({ ...detail, interactions: [interaction] })
        : original?.(path),
  );
  await openPerson();
  await click('修改经历');
  await act(async () => setText('textarea[aria-label="经历内容"]', '谈论新的合作方式'));
  await click('保存经历');
  const body = JSON.parse(apiFetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1].body);
  expect(body).toEqual(
    expect.objectContaining({
      action: 'amend_event',
      eventId: 'event-a',
      expectedRevision: 'event-revision-1',
      payload: {
        eventKind: 'meeting',
        headline: '谈论新的合作方式',
        importanceOrTopic: '合作方式',
        uncertaintyNotes: ['具体日期不确定'],
      },
    }),
  );
  expect(body.payload.occurredAt).toBeUndefined();
});
it('keeps the server revision and reuses one request id when an uncertain correction is retried', async () => {
  await openPerson();
  await click('修改判断');
  await act(async () => setText('textarea[aria-label="判断内容"]', '更愿意听取不同意见'));
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? response({ error: 'mutation_unavailable' }, 503)
      : path.includes('/source?')
        ? response({ status: 'unavailable', sources: [] })
        : response(detail),
  );
  await click('保存修改');
  expect(host.textContent).toContain('暂时无法修改');
  await click('重试这次操作');
  const bodies = apiFetch.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body));
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(
    expect.objectContaining({
      action: 'correct_claim',
      claimId: 'claim-a',
      expectedRevision: 'claim-revision-1',
      payload: { ...claim.payload, statement: '更愿意听取不同意见' },
    }),
  );
  expect(bodies[0].requestId.length).toBeGreaterThanOrEqual(32);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(host.textContent).toContain('愿意听取不同意见');
});
it('requires explicit permanent-forget confirmation and keeps stale data unchanged until reread', async () => {
  await openPerson();
  await click('忘掉这个人');
  expect(host.textContent).toContain('永久删除');
  expect(host.textContent).toContain('不会删除原始对话');
  expect(button('确认永久遗忘')?.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
  apiFetch.mockResolvedValue(response({ error: 'stale_revision' }, 409));
  await click('确认永久遗忘');
  const call = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
  const body = JSON.parse(call?.[1].body);
  expect(body).toEqual(
    expect.objectContaining({
      action: 'hard_forget_person',
      expectedPersonRevision: 'person-revision-1',
      confirmed: true,
    }),
  );
  expect(personForgetRequestIdSchema.safeParse(body.requestId).success).toBe(true);
  expect(body.requestId.length).toBeGreaterThanOrEqual(32);
  expect(host.textContent).toContain('版本已变化');
  expect(host.textContent).toContain('小林');
  expect(button('确认永久遗忘')?.disabled).toBe(true);
});
it('keeps the original forget command after a lost response even when the owner clicks the original confirmation again', async () => {
  await openPerson();
  await click('忘掉这个人');
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
  let appliedRequestId: string | null = null;
  const original = apiFetch.getMockImplementation();
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (!appliedRequestId) {
        appliedRequestId = body.requestId;
        throw new TypeError('Response lost after the server applied the forget');
      }
      return body.requestId === appliedRequestId
        ? response({ action: 'hard_forget_person', outcome: 'replayed' })
        : response({ error: 'not_available' }, 404);
    }
    return path.startsWith('/api/memory/people?') && appliedRequestId
      ? response({ readStatus: 'ready', entries: [], meta: { count: 0, limit: 20, offset: 0, hasMore: false } })
      : original?.(path);
  });
  await click('确认永久遗忘');
  expect(host.textContent).toContain('暂时无法修改');
  await click('确认永久遗忘');
  expect(apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(button('确认永久遗忘')?.disabled).toBe(true);
  expect(button('忘掉这个人')?.disabled).toBe(true);
  await click('重试这次操作');
  const bodies = apiFetch.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body));
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(
    expect.objectContaining({
      action: 'hard_forget_person',
      expectedPersonRevision: 'person-revision-1',
      confirmed: true,
    }),
  );
  expect(personForgetRequestIdSchema.safeParse(bodies[0].requestId).success).toBe(true);
  expect(bodies[0].requestId.length).toBeGreaterThanOrEqual(32);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(host.querySelector('aside[aria-label="人物详情"]')).toBeNull();
  expect(button('小林')).toBeUndefined();
});
