import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryTaste } from '../MemoryTaste';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => null }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
vi.mock('../MemoryTasteSky', () => ({ MemoryTasteSky: () => null }));
const revision = `sha256:${'a'.repeat(64)}`;
const candidateRevision = `sha256:${'b'.repeat(64)}`;
const taste = {
  id: 'taste-a',
  revision,
  visibility: 'public',
  status: 'active',
  takeawayCandidate: {
    status: 'pending_owner_confirmation',
    takeaway: '先展示实物再判断',
    basedOnRevision: revision,
    candidateRevision,
  },
  title: '已经批准的判断',
  when: '2026-10-06',
  quotes: ['先看实物'],
  scene: '讨论界面',
  takeaway: '已经批准的判断',
  tags: ['设计'],
  dimension: 'visual-quality',
  catId: null,
  recall: null,
};
const profile = {
  id: 'corpus',
  type: 'profile',
  layer: 'corpus',
  relationshipKey: null,
  uri: 'cat-cafe-profile://corpus/current',
  title: '共同画像',
  status: 'active',
  revision,
  content: '先给结果，再按需看过程。',
};
const entity = {
  id: 'entity-a',
  type: 'entity',
  revision,
  status: 'active',
  entityType: 'concept',
  canonicalName: '设计',
  aliases: ['界面'],
  stance: 'neutral',
  visibilityScope: 'workspace',
  updatedAt: '2026-10-06',
  provenanceCount: 0,
  provenance: [],
};
const event = {
  eventId: 'event-a',
  ownerUserId: 'owner',
  type: '数学之美',
  trigger: 'human_brake',
  cat: 'codex61-sol',
  threadId: 'thread-a',
  messageId: 'message-a',
  timestamp: 100,
  summary: '先把目标想清楚，再删掉不需要的复杂度。',
  cognitiveTransition: null,
  relatedHarness: null,
  confidence: 'high',
  revision,
  status: 'active',
};
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
let host: HTMLDivElement;
let root: Root;
const findButton = (name: string) =>
  [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === name);
async function click(name: string) {
  const button = findButton(name);
  expect(button, name).toBeDefined();
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
}
function setText(name: string, value: string) {
  const node = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${name}"]`);
  expect(node).not.toBeNull();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(node, value);
  node?.dispatchEvent(new Event('input', { bubbles: true }));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return response({ error: 'mutation_unavailable' }, 503);
    if (path.includes('/source?') || path.endsWith('/source'))
      return response({ status: 'not_recorded', sources: [], title: null, canOpen: false });
    const reads: Record<string, unknown> = {
      '/api/memory/taste': { readStatus: 'ready', entries: [taste], coverage: null },
      '/api/memory/profile': { readStatus: 'ready', entries: [profile] },
      '/api/memory/entities': { readStatus: 'ready', entries: [entity] },
      '/api/memory/events?limit=20&offset=0': {
        events: [event],
        meta: { count: 1, offset: 0, limit: 20, hasMore: false },
      },
    };
    const detail = new Map<string, unknown>([
      ['/api/memory/taste/', taste],
      ['/api/memory/profile/', profile],
      ['/api/memory/entities/', entity],
      ['/api/memory/events/', event],
    ]);
    if (path in reads) return response(reads[path]);
    const record = [...detail].find(([prefix]) => path.startsWith(prefix));
    return record ? response(record[1]) : response({ error: 'not_available' }, 404);
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('replaces an owner profile through its original route with the read revision and no forged callback identity', async () => {
  await act(async () => root.render(<MemoryTaste />));
  await click('画像');
  await click('共同画像');
  await click('编辑');
  await act(async () => setText('画像内容', '先给清楚的结果。'));
  await click('保存');
  const call = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(call?.[0]).toBe('/api/memory/profile/corpus/actions');
  expect(JSON.parse(call?.[1].body)).toEqual(
    expect.objectContaining({ action: 'replace_content', expectedRevision: revision, content: '先给清楚的结果。' }),
  );
  expect(Object.keys(call?.[1].headers)).toEqual(['Content-Type']);
  expect(host.textContent).toContain('暂时无法修改');
});
it('confirms a candidate against both revisions without upgrading a mismatched target receipt into success', async () => {
  await act(async () => root.render(<MemoryTaste />));
  expect(host.querySelector('[data-testid="taste-card"]')?.textContent).toContain('待你确认');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="taste-card"] button')?.click());
  expect(host.textContent).toContain('已经批准的判断');
  apiFetch.mockImplementation(async (_path: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? response({ action: 'confirm_takeaway', outcome: 'applied', memoryId: 'another-taste' })
      : response(taste),
  );
  await click('确认这句');
  const body = JSON.parse(apiFetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1].body);
  expect(body).toEqual(
    expect.objectContaining({
      action: 'confirm_takeaway',
      expectedRevision: revision,
      candidateRevision,
      takeaway: taste.takeawayCandidate.takeaway,
    }),
  );
  expect(host.textContent).toContain('结果尚未确认');
  expect(host.textContent).toContain('已经批准的判断');
});
it('edits an entity through the entity action contract rather than a person command or registry write', async () => {
  await act(async () => root.render(<MemoryTaste />));
  await click('实体');
  await click('设计');
  await click('修改实体');
  await act(async () => setText('实体名称', '产品设计'));
  await click('保存实体');
  const call = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(call?.[0]).toBe('/api/memory/entities/entity-a/actions');
  expect(JSON.parse(call?.[1].body)).toEqual(
    expect.objectContaining({
      action: 'correct',
      expectedRevision: revision,
      patch: { canonicalName: '产品设计', aliases: ['界面'] },
    }),
  );
});
it.each([
  ['实体', '设计'],
  ['画像', '共同画像'],
])('discloses retained immutable %s audit before permitting permanent forgetting', async (family, title) => {
  await act(async () => root.render(<MemoryTaste />));
  await click(family);
  await click(title);
  await click(`忘掉${family}`);
  expect(host.textContent).toContain('不可变更的版本审计记录仍保留');
  expect(findButton('确认永久遗忘')?.disabled).toBe(true);
});
it('reads and corrects an event independently of the human-brake grouping and retains its source identity', async () => {
  await act(async () => root.render(<MemoryTaste />));
  await click('事件');
  await click('数学之美');
  await click('修改事件');
  await act(async () => setText('事件内容', '先看清目标，再去掉不需要的复杂度。'));
  await click('保存事件');
  const call = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(call?.[0]).toBe('/api/memory/events/event-a/actions');
  const body = JSON.parse(call?.[1].body);
  expect(body).toEqual(
    expect.objectContaining({
      action: 'correct',
      expectedRevision: revision,
      patch: { summary: '先看清目标，再去掉不需要的复杂度。' },
    }),
  );
  expect(body.threadId).toBeUndefined();
  expect(body.messageId).toBeUndefined();
});
