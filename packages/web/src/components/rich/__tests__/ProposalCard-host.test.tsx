import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApprovalHost, ApprovalHostContext } from '@/components/ApprovalHost';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ProposalCard } from '../ProposalCard';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));
vi.mock('@/stores/chatStore', () => {
  const state = { threads: [], currentThreadId: null };
  const useChatStore = (selector: (value: typeof state) => unknown) => selector(state);
  useChatStore.getState = () => state;
  return { useChatStore };
});
const block: RichCardBlock = {
  id: 'proposal-bound',
  kind: 'card',
  v: 1,
  title: '提议新建 thread：A real original card',
  fields: [
    { label: '父 Thread', value: 'parent-thread' },
    { label: '建议成员', value: 'codex61-sol' },
    { label: '项目归属', value: '/isolated/project' },
  ],
  actions: [{ label: '批准并创建', action: 'propose:approve', payload: { proposalId: 'proposal-1' } }],
};
let container: HTMLDivElement;
let root: Root;
let host: ApprovalHost;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(pushThreadRouteWithHistory).mockClear();
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async (_path, init) =>
      Response.json(init?.method === 'POST' ? { threadId: 'created-thread' } : { proposal: { status: 'pending' } }),
    );
  host = {
    presentation: 'mailbox',
    writesLocked: false,
    authorizeWrite: vi.fn(() => true),
    reportEditing: vi.fn(),
    reportRequest: vi.fn(),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <ApprovalHostContext.Provider value={host}>
        <ProposalCard block={block} />
      </ApprovalHostContext.Provider>,
    ),
  );
}
function button(label: RegExp) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    label.test(b.textContent ?? ''),
  );
  if (!found) throw new Error(`Missing original control: ${label}`);
  return found;
}
const posts = () => vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'POST');

describe('original ProposalCard under its containing owner/read host', () => {
  it.each([
    'mailbox',
    undefined,
  ] as const)('includes pin in the authorized approval but rechecks authority before navigation (%s)', async (presentation) => {
    host = { ...host, presentation };
    vi.mocked(host.authorizeWrite).mockImplementation((_kind, options) => !options?.continuation);
    await render();
    const pin = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => pin?.click());
    await act(async () => button(/批准/).click());
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({ pinned: true });
    expect(vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'PATCH')).toHaveLength(0);
    expect(pushThreadRouteWithHistory).not.toHaveBeenCalled();
  });
  it.each([
    ['approve', /批准/],
    ['reject', /驳回/],
  ] as const)('refuses %s while the containing read is locked', async (_action, label) => {
    host = { ...host, writesLocked: true };
    await render();
    await act(async () => button(label).click());
    expect(posts()).toHaveLength(0);
  });
  it('checks current authority at the press, including a refusal after rendering', async () => {
    await render();
    vi.mocked(host.authorizeWrite).mockReturnValue(false);
    await act(async () => button(/批准/).click());
    expect(host.authorizeWrite).toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
  });
  it('keeps editing/cancel available during a locked read and reports its draft to the host', async () => {
    host = { ...host, writesLocked: true };
    await render();
    await act(async () => button(/^编辑$/).click());
    expect(container.querySelectorAll('input,textarea').length).toBeGreaterThan(0);
    expect(host.reportEditing).toHaveBeenCalledWith('thread-proposal', true);
    await act(async () => button(/取消编辑/).click());
    expect(host.reportEditing).toHaveBeenCalledWith('thread-proposal', false);
    expect(posts()).toHaveLength(0);
  });
});
