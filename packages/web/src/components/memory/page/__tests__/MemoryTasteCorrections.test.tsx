import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryTasteDetail } from '../MemoryTasteDetail';
import type { TasteMemory } from '../taste-types';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ displayName: '砚砚' }) }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
const revision = `sha256:${'a'.repeat(64)}`;
const proposal = {
  proposalId: 'taste-proposal-a',
  status: 'pending' as const,
  expectedRevision: revision,
  reason: 'outdated' as const,
  suggestedPatch: { takeaway: '先展示实物，再判断。' },
  sourceCatId: 'codex61-sol',
  sourceThreadId: 'thread-a',
  createdAt: 100,
};
const taste = {
  id: 'taste-a',
  revision,
  visibility: 'public' as const,
  title: '原来的品味',
  when: '2026-10-06',
  quotes: ['先看实物'],
  scene: '讨论界面',
  takeaway: '原来的判断。',
  status: 'active' as const,
  tags: ['设计'],
  dimension: 'visual-quality',
  catId: null,
  recall: null,
  pendingCorrectionCount: 1,
  correctionProposals: [proposal],
};
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
let host: HTMLDivElement;
let root: Root;
const reload = vi.fn();
const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
async function click(text: string) {
  expect(button(text), text).toBeDefined();
  await act(async () => button(text)?.click());
}
async function render(data: unknown = taste) {
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? response({ error: 'mutation_unavailable' }, 503)
      : path.includes('/source?')
        ? response({ status: 'not_recorded', title: null, canOpen: false })
        : response(data),
  );
  await act(async () =>
    root.render(<MemoryTasteDetail entry={taste as TasteMemory} close={vi.fn()} reload={reload} />),
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('attaches the suggestion to the original Taste and retries only its matching F221 decision', async () => {
  await render();
  expect(host.textContent).toContain('原来的判断。');
  expect(host.textContent).toContain('先展示实物，再判断。');
  expect(host.textContent).toContain('砚砚');
  apiFetch.mockResolvedValueOnce(response({ proposalId: 'another-proposal', status: 'approved' }));
  await click('接受这条建议');
  expect(reload).not.toHaveBeenCalled();
  expect(host.querySelector('h3')?.textContent).toBe('原来的判断。');
  expect(host.textContent).toContain('结果尚未确认');
  apiFetch.mockResolvedValueOnce(response({ proposalId: proposal.proposalId, status: 'approved' }));
  await click('重试这次决定');
  const writes = apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.map(([path]) => path)).toEqual(Array(2).fill('/api/taste-proposals/taste-proposal-a/approve'));
  expect(writes[0][1].body).toBe(writes[1][1].body);
  expect(reload).toHaveBeenCalledOnce();
});

it('blocks stale acceptance while preserving explicit rejection of the same suggestion', async () => {
  await render({ ...taste, correctionProposals: [{ ...proposal, expectedRevision: `sha256:${'b'.repeat(64)}` }] });
  expect(button('接受这条建议')?.disabled).toBe(true);
  apiFetch.mockResolvedValueOnce(response({ proposalId: proposal.proposalId, status: 'rejected' }));
  await click('拒绝这条建议');
  expect(apiFetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[0]).toBe(
    '/api/taste-proposals/taste-proposal-a/reject',
  );
  expect(reload).toHaveBeenCalledOnce();
});

it('resumes the existing approving Taste proposal after its canonical revision changed', async () => {
  await render({
    ...taste,
    revision: `sha256:${'b'.repeat(64)}`,
    correctionProposals: [{ ...proposal, status: 'approving' }],
  });
  apiFetch.mockResolvedValueOnce(response({ proposalId: proposal.proposalId, status: 'approved', recovered: true }));
  await click('重试这次接受');
  expect(reload).toHaveBeenCalledOnce();
});

it('does not render an invalid correction projection as an ordinary Taste with zero suggestions', async () => {
  await render({ ...taste, correctionProposals: [{ ...proposal, suggestedPatch: { takeaway: 12 } }] });
  expect(host.textContent).not.toContain('原来的判断。');
  expect(host.textContent).toContain('重读');
  expect(button('接受这条建议')).toBeUndefined();
});

it('discloses retained Git and proposal audit before permanent Taste forgetting', async () => {
  await render();
  await click('忘掉品味');
  expect(host.textContent).toContain('不可变更的版本审计记录仍保留');
  expect(button('确认永久遗忘')?.disabled).toBe(true);
  expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
