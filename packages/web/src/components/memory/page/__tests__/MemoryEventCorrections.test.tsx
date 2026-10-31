import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryEventDetail } from '../MemoryEventDetail';
import type { MemoryEvent } from '../owner-memory-read';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ displayName: '砚砚' }) }) }));
const revision = `sha256:${'a'.repeat(64)}`;
const proposal = {
  proposalId: 'proposal-a',
  status: 'pending',
  expectedRevision: revision,
  reason: 'outdated',
  suggestedPatch: { summary: '后来有了新的证据。' },
  sourceCatId: 'codex61-sol',
  sourceThreadId: 'thread-a',
  source: { threadId: 'thread-a', messageId: 'message-a' },
  createdAt: 100,
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
  summary: '原来的解释。',
  cognitiveTransition: null,
  relatedHarness: null,
  confidence: 'high',
  revision,
  status: 'active',
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
async function render(data = event) {
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? response({ error: 'mutation_unavailable' }, 503)
      : path.includes('/source?')
        ? response({ status: 'not_recorded', sources: [] })
        : response(data),
  );
  await act(async () => root.render(<MemoryEventDetail entry={data as MemoryEvent} close={vi.fn()} reload={reload} />));
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
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('attaches a cat correction to the original event and rereads only after a matching approved receipt', async () => {
  await render();
  expect(host.textContent).toContain('原来的解释。');
  expect(host.textContent).toContain('后来有了新的证据。');
  expect(host.textContent).toContain('砚砚');
  apiFetch.mockResolvedValueOnce(
    response({ proposalId: 'different-proposal', status: 'approved', appliedRevision: revision }),
  );
  await click('接受这条建议');
  expect(reload).not.toHaveBeenCalled();
  expect(host.textContent).toContain('结果尚未确认');
  apiFetch.mockResolvedValueOnce(response({ proposalId: 'proposal-a', status: 'approved', appliedRevision: revision }));
  await click('重试这次决定');
  const writes = apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.map(([path]) => path)).toEqual(Array(2).fill('/api/event-memory-corrections/proposal-a/approve'));
  expect(writes[0][1].body).toBe(writes[1][1].body);
  expect(reload).toHaveBeenCalledOnce();
});

it('blocks acceptance of a stale suggestion while leaving explicit rejection available', async () => {
  await render({ ...event, correctionProposals: [{ ...proposal, expectedRevision: `sha256:${'b'.repeat(64)}` }] });
  expect(button('接受这条建议')?.disabled).toBe(true);
  expect(host.textContent).toContain('记忆已变更');
  apiFetch.mockResolvedValueOnce(response({ proposalId: 'proposal-a', status: 'rejected' }));
  await click('拒绝这条建议');
  expect(apiFetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[0]).toBe(
    '/api/event-memory-corrections/proposal-a/reject',
  );
  expect(reload).toHaveBeenCalledOnce();
});

it('lets the owner resume an interrupted approval after the Event mutation changed its revision', async () => {
  await render({
    ...event,
    revision: `sha256:${'b'.repeat(64)}`,
    correctionProposals: [{ ...proposal, status: 'approving' }],
  });
  apiFetch.mockResolvedValueOnce(
    response({ proposalId: 'proposal-a', status: 'approved', appliedRevision: `sha256:${'b'.repeat(64)}` }),
  );
  await click('重试这次接受');
  expect(reload).toHaveBeenCalledOnce();
});
