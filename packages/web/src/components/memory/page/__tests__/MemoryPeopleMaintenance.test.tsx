import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useToastStore } from '@/stores/toastStore';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { MemoryPeople } from '../MemoryPeople';
import { MemorySourceDetail } from '../MemorySourceDetail';
import {
  readPendingPersonMaintenance,
  rememberPersonMaintenance,
  settlePersonMaintenance,
} from '../person-maintenance-recovery';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('../MemoryDeliveryUsage', () => ({ MemoryDeliveryUsage: () => null }));
vi.mock('../MemoryOriginalProposals', () => ({ MemoryPersonProposals: () => null }));
const revision = `sha256:${'1'.repeat(64)}`;
const claim = {
  claimId: 'person_claim_sample',
  revision,
  status: 'retired',
  recordedAt: 100,
  payload: { kind: 'reported_fact', predicate: 'team', value: '旧内容', assertedBy: 'owner' },
  sourceCount: 1,
};
const person = {
  personId: 'person_sample',
  displayName: '示例人物',
  aliases: [],
  status: 'active',
  createdAt: 100,
  updatedAt: 100,
  currentClaimCount: 0,
  activeInteractionCount: 1,
};
const detail = {
  ...person,
  personRevision: revision,
  sourceCount: 1,
  claims: [claim],
  relationships: [],
  interactions: [
    {
      eventId: 'person_event_sample',
      revision,
      status: 'redacted',
      recordedAt: 100,
      eventKind: 'meeting',
      headline: '[redacted]',
      sourceCount: 0,
    },
  ],
  truncation: { claims: false, relationships: false, interactions: false },
};
const receiptId = `deferred_person_${'a'.repeat(32)}`;
const receipt = {
  receiptId,
  revision,
  subject: '示例人物',
  state: 'awaiting_confirmation',
  createdAt: 100,
  updatedAt: 100,
  sourceCount: 1,
};
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
let host: HTMLDivElement, root: Root;
let currentDetail: unknown = detail;
let entries: unknown[];
let post: (path: string, init: RequestInit) => Promise<unknown>;
const buttons = (text: string) => [...host.querySelectorAll('button')].filter((n) => n.textContent?.trim() === text);
async function click(text: string) {
  expect(buttons(text).length, text).toBeGreaterThan(0);
  await act(async () => buttons(text)[0]?.click());
}
async function render() {
  await act(async () => root.render(<MemoryPeople />));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  observeApiSessionOwner('owner-A');
  currentDetail = detail;
  entries = [receipt];
  post = async () => response({ outcome: 'applied', action: 'redact_item' });
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return post(path, init);
    if (path.startsWith('/api/memory/people/deferred?')) return response({ entries, nextCursor: null });
    if (path.startsWith('/api/memory/people?'))
      return response({
        readStatus: 'ready',
        entries: [person],
        meta: { count: 1, limit: 20, offset: 0, hasMore: false },
      });
    if (path.includes('/source?')) return response({ status: 'unavailable', sources: [] });
    return response(currentDetail);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  localStorage.clear();
  observeApiSessionOwner(null);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('preserves both confirmed coordinates when two tabs interleave their first storage write', () => {
  const originalSet = Storage.prototype.setItem;
  let interleaved = false;
  let otherRequest = '';
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (!interleaved) {
      interleaved = true;
      otherRequest = rememberPersonMaintenance('owner-A', {
        action: 'withdraw',
        receiptId: `deferred_person_${'b'.repeat(32)}`,
        expectedRevision: revision,
      }).requestId;
    }
    originalSet.call(this, key, value);
  });
  try {
    const first = rememberPersonMaintenance('owner-A', {
      action: 'forget',
      receiptId,
      expectedRevision: revision,
    });
    settlePersonMaintenance('owner-A', first);
    expect(readPendingPersonMaintenance('owner-A')?.requestId).toBe(otherRequest);
  } finally {
    spy.mockRestore();
  }
});

it('redacts an exact historical claim even when its source is unavailable, with cancel and refresh', async () => {
  await render();
  await click('示例人物');
  expect(host.textContent).toContain('旧内容');
  await click('忘掉这条内容');
  expect(host.textContent).toContain('不会删除原始对话');
  await click('取消');
  expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  await click('忘掉这条内容');
  post = async () => {
    currentDetail = { ...detail, claims: [{ ...claim, status: 'redacted', payload: { kind: 'redacted' } }] };
    return response({ action: 'redact_item', outcome: 'applied' });
  };
  await click('确认忘掉这条内容');
  const [path, init] = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST') ?? [];
  expect(path).toBe('/api/memory/people/person_sample/actions');
  expect(JSON.parse(init.body)).toMatchObject({
    action: 'redact_item',
    item: { kind: 'claim', id: claim.claimId },
    expectedRevision: revision,
    confirmed: true,
  });
  expect(host.textContent).not.toContain('旧内容');
  expect(host.textContent).toContain('这条内容已遗忘');
  expect(host.textContent).not.toContain('[redacted]');
  expect(useToastStore.getState().toasts.some((toast) => toast.title === '已忘掉')).toBe(true);
});

it('shows terminal deferred markers without resurrecting names and sends bound proposals to the existing mailbox', async () => {
  entries = [
    { ...receipt, subject: undefined, state: 'withdrawn' },
    {
      ...receipt,
      receiptId: `deferred_person_${'b'.repeat(32)}`,
      subject: undefined,
      state: 'proposed',
      proposalId: 'person_candidate_bound',
      proposalSection: 'history',
    },
  ];
  await render();
  expect(host.textContent).toContain('暂存的人物线索');
  expect(host.textContent).toContain('内容已清空');
  expect(buttons('撤回')).toHaveLength(0);
  expect(buttons('永久遗忘')).toHaveLength(1);
  const navigate = vi.fn();
  window.addEventListener('cat-cafe:mailbox-navigate', navigate);
  await click('前往原提议处理');
  expect(navigate.mock.calls[0]?.[0].detail.proposalId).toBe('person_candidate_bound');
  window.removeEventListener('cat-cafe:mailbox-navigate', navigate);
});

it('labels an interrupted permanent forget honestly and can finish it from the current owner page', async () => {
  entries = [{ ...receipt, subject: undefined, state: 'withdrawn', pendingAction: 'forget' }];
  await render();
  expect(host.textContent).toContain('永久遗忘尚未完成');
  expect(host.textContent).not.toContain('已撤回的暂存记录');
  expect(buttons('撤回')).toHaveLength(0);
  post = async () => {
    entries = [];
    return response({ action: 'forget', outcome: 'applied' });
  };
  await click('继续永久遗忘');
  await click('确认继续永久遗忘');
  const write = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(write?.[1].body)).toMatchObject({ action: 'forget', expectedRevision: revision, confirmed: true });
  expect(host.textContent).not.toContain('永久遗忘尚未完成');
});

it('retains the same confirmed request across a lost success response, removed row, unmount and reload', async () => {
  await render();
  post = async () => {
    entries = [];
    throw new TypeError('lost committed response');
  };
  await click('永久遗忘');
  await click('确认永久遗忘');
  const first = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(first).toBeDefined();
  expect(host.textContent).toContain('结果尚未确认');
  await act(() => root.unmount());
  root = createRoot(host);
  await render();
  expect(buttons('永久遗忘')).toHaveLength(0);
  expect(buttons('重试这次操作')).toHaveLength(1);
  post = async () => response({ action: 'forget', outcome: 'replayed' });
  await click('重试这次操作');
  const writes = apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[1]?.[0]).toBe(first?.[0]);
  expect(writes[1]?.[1].body).toBe(first?.[1].body);
  expect(buttons('重试这次操作')).toHaveLength(0);
});

it('isolates an unresolved request by observed owner and requires a new decision after a version conflict', async () => {
  await render();
  post = async () => {
    throw new Error('network');
  };
  await click('撤回');
  await click('确认撤回');
  expect(buttons('重试这次操作')).toHaveLength(1);
  await act(async () => observeApiSessionOwner('owner-B'));
  expect(buttons('重试这次操作')).toHaveLength(0);
  await act(async () => observeApiSessionOwner('owner-A'));
  expect(buttons('重试这次操作')).toHaveLength(1);
  post = async () => response({ error: 'stale_revision' }, 409);
  await click('重试这次操作');
  expect(host.textContent).toContain('版本已变化');
  expect(buttons('重试这次操作')).toHaveLength(0);
});

it('keeps an empty scan window pageable and labels a failed deferred read instead of declaring no records', async () => {
  const original = apiFetch.getMockImplementation();
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) =>
    path.startsWith('/api/memory/people/deferred?')
      ? response({ entries: [], nextCursor: '42' })
      : original?.(path, init),
  );
  await render();
  expect(buttons('读取更多暂存条目')).toHaveLength(1);
  expect(host.textContent).not.toContain('当前没有暂存的人物线索');
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) =>
    path.includes('cursor=42') ? response({ error: 'unavailable' }, 503) : original?.(path, init),
  );
  await click('读取更多暂存条目');
  expect(host.textContent).toContain('暂存条目暂时读不到');
});

it('keeps a lost redaction recoverable on a source link whose frozen revision is no longer readable', async () => {
  await render();
  await click('示例人物');
  post = async () => {
    throw new TypeError('lost committed response');
  };
  await click('忘掉这条内容');
  await click('确认忘掉这条内容');
  await act(() => root.unmount());
  root = createRoot(host);
  apiFetch.mockImplementation(async () => response({ error: 'Revision changed' }, 409));
  await act(async () =>
    root.render(<MemorySourceDetail target={{ status: 'ready', family: 'person', id: person.personId, revision }} />),
  );
  expect(host.textContent).toContain('改过');
  expect(buttons('重试这次操作')).toHaveLength(1);
});
