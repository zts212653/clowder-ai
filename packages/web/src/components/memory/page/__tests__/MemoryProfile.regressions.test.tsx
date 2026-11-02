import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { MemoryProfile } from '../MemoryProfile';
import { ProfileDetail } from '../MemoryProfileDetail';
import type { ProfileMemoryRead } from '../owner-memory-read';

const { apiFetch, registry } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  registry: { cats: [] as CatData[], hasFetched: false },
}));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => registry }));
vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: ({ catId }: { catId: string }) => <span data-cat-id={catId} />,
}));
const entry: ProfileMemoryRead = {
  id: 'primer:astra',
  type: 'profile',
  layer: 'primer',
  relationshipKey: 'astra',
  uri: 'cat-cafe-profile://relationship/current',
  title: '关系画像',
  status: 'active',
  revision: `sha256:${'a'.repeat(64)}`,
  content: '关系正文。',
  proposals: [],
};
const capsule = {
  ...entry,
  id: 'capsule',
  layer: 'capsule' as const,
  relationshipKey: null,
  content: '关于你的正文。',
};
const response = (data: unknown) => ({ ok: true, json: async () => data });
let host: HTMLDivElement;
let root: Root;
let forgotten: boolean;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  registry.cats = [];
  registry.hasFetched = false;
  forgotten = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      forgotten = true;
      return response({
        memoryId: entry.id,
        action: 'hard_forget',
        outcome: 'applied',
        revision: entry.revision,
        forgetScope: {
          canonicalMemory: 'deleted',
          derivedProjections: 'invalidated',
          originalSource: 'preserved',
          immutableAudit: 'retained',
        },
      });
    }
    if (path.includes('/source?')) return response({ status: 'not_recorded', sources: [] });
    if (path === '/api/memory/profile')
      return response({ readStatus: 'ready', entries: forgotten ? [capsule] : [capsule, entry] });
    return response(path.includes('/capsule?') ? capsule : entry);
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const open = () => act(async () => root.render(<MemoryProfile onReadSummary={() => {}} />));
async function click(name: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === name);
  expect(button, name).toBeDefined();
  await act(async () => button?.click());
}

it('projects unread, matched and verified-unlinked identity consistently in both card and detail', async () => {
  await open();
  expect(host.textContent).not.toContain('未关联');
  await click('关系画像');
  expect(host.querySelector('aside')?.textContent).toContain('成员资料尚未读到');
  expect(host.querySelectorAll('[data-cat-id]')).toHaveLength(0);
  registry.cats = [
    {
      id: 'astra-v2',
      relationshipKey: 'astra',
      nickname: '小星星',
      displayName: '缅因猫 Astra',
      defaultModel: 'v2',
    } as CatData,
  ];
  registry.hasFetched = true;
  await open();
  expect(host.querySelector('aside')?.textContent).toContain('与 小星星 的关系画像');
  expect(host.querySelectorAll('[data-cat-id="astra-v2"]')).toHaveLength(2);
  registry.cats = [];
  await open();
  expect(host.querySelector('aside')?.textContent).toContain('未关联成员的关系画像');
  expect(host.textContent).not.toContain('成员资料尚未读到');
});

it('returns to About you when a selected relationship is forgotten', async () => {
  registry.hasFetched = true;
  await open();
  await click('未关联成员的关系画像');
  await click('忘掉画像');
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
  await click('确认永久遗忘');
  expect(forgotten).toBe(true);
  expect(host.querySelector('aside')?.textContent).toContain('关于你的正文。');
  expect(host.textContent).not.toContain('关系正文。');
});

it.each(['primer', 'corpus'] as const)('offers the same Edit entry and an inline editor for %s', async (layer) => {
  const profile = { ...entry, layer, id: layer === 'primer' ? entry.id : 'corpus' };
  apiFetch.mockImplementation(async (path: string) =>
    response(path.includes('/source?') ? { status: 'not_recorded', sources: [] } : profile),
  );
  await act(async () => root.render(<ProfileDetail entry={profile} close={() => {}} reload={() => {}} />));
  await click('编辑');
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="画像内容"]')?.value).toBe(entry.content);
  expect(host.querySelectorAll('form')).toHaveLength(1);
  expect(host.textContent).not.toContain('修改画像');
});

it('keeps the recorded historical model distinct from the member current model when displaying it', async () => {
  registry.cats = [
    {
      id: 'astra-v2',
      relationshipKey: 'astra',
      displayName: '缅因猫 Sol',
      nickname: '小太阳',
      variantLabel: 'GPT-6.1 Sol',
      defaultModel: 'gpt-6.1-sol',
    } as CatData,
  ];
  registry.hasFetched = true;
  const opening = {
    asOf: '2026-10-03',
    excerpts: [
      {
        kind: 'model_capability',
        model: 'gpt-5.4',
        text: '当时能完成校对。',
        source: { threadId: 'old-thread', messageId: 'old-message' },
      },
    ],
  };
  const historical = { ...entry, content: `---\n${JSON.stringify({ opening })}\n---\n${entry.content}` };
  apiFetch.mockImplementation(async (path: string) =>
    response(path.includes('/source?') ? { status: 'not_recorded', sources: [] } : historical),
  );
  await act(async () => root.render(<ProfileDetail entry={historical} close={() => {}} reload={() => {}} />));
  const reference = host.querySelector('section[aria-label="开场关系参考"]');
  expect(reference?.textContent).toContain('历史能力判断 · GPT 5.4');
  expect(reference?.textContent).not.toContain('GPT-6.1 Sol');
  await click('修改开场参考');
  expect(reference?.textContent).toContain('历史能力判断 · GPT 5.4');
});
