import { createCatId, type ThreadProposal } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApprovalHost, ApprovalHostContext } from '@/components/ApprovalHost';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '@/components/shell/shell-presentation';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { ProposalCard } from '../ProposalCard';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));
vi.mock('@/stores/chatStore', () => {
  const state = { threads: [], currentThreadId: null };
  const useChatStore = (selector: (value: typeof state) => unknown) => selector(state);
  useChatStore.getState = () => state;
  return { useChatStore };
});
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [], getCatById: () => undefined }) }));
vi.mock('@/hooks/useThreadDisplayInfo', () => ({
  useThreadDisplayInfo: () => ({ currentThread: { title: 'Parent discussion' } }),
}));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ refreshSidebarThreadSnapshot: vi.fn(async () => true) }));
const proposal: ThreadProposal = {
  proposalId: 'proposal-1',
  status: 'pending',
  sourceThreadId: 'parent-thread',
  sourceInvocationId: 'source-invocation',
  sourceCatId: createCatId('codex61-sol'),
  title: 'A real original card',
  reason: 'Keep the containing owner and source authority.',
  parentThreadId: 'parent-thread',
  preferredCats: [createCatId('codex61-sol')],
  initialMessage: 'Verify the original result.',
  projectPath: '/isolated/project',
  createdBy: 'owner-1',
  createdAt: 1,
};
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
  observeApiSessionOwner('owner-1');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(pushThreadRouteWithHistory).mockClear();
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async (path, init) => {
      if (init?.method === 'POST' && path === '/api/proposals/proposal-1/approve')
        return Response.json({ threadId: 'created-thread' });
      if (init?.method === 'POST' && path === '/api/proposals/proposal-1/reject') return Response.json({ ok: true });
      if (!init?.method && path === '/api/proposals/proposal-1') return Response.json({ proposal });
      if (!init?.method && path === '/api/config/thread-attention') return Response.json({ groups: [] });
      throw new Error(`Unexpected proposal host request: ${path}`);
    });
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
  window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
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

describe.each([
  'classic',
  'v2',
] as const)('original ProposalCard under its containing owner/read host (%s)', (presentation) => {
  beforeEach(() => writeShellPresentation(presentation));
  const approve = () => button(presentation === 'classic' ? /批准/ : /^同意$/);
  const reject = () => button(presentation === 'classic' ? /驳回/ : /^拒绝$/);
  const edit = () => button(presentation === 'classic' ? /^编辑$/ : /^让.+改…$/);
  it.each([
    ['mailbox', 'checked'],
    [undefined, 'checked'],
    ['mailbox', 'default'],
    ['mailbox', 'unchecked'],
  ] as const)('preserves pin=%s/%s and rechecks authority before navigation', async (placement, selection) => {
    host = { ...host, presentation: placement };
    vi.mocked(host.authorizeWrite).mockImplementation((_kind, options) => !options?.continuation);
    await render();
    const pin = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(pin?.checked).toBe(false);
    if (selection !== 'default') await act(async () => pin?.click());
    if (selection === 'unchecked') await act(async () => pin?.click());
    expect(pin?.checked).toBe(selection === 'checked');
    await act(async () => approve().click());
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.[0]).toBe('/api/proposals/proposal-1/approve');
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({
      ...(presentation === 'v2' ? { projectPath: proposal.projectPath, attentionGroupId: null } : {}),
      ...(selection === 'checked' ? { pinned: true } : {}),
    });
    expect(vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'PATCH')).toHaveLength(0);
    expect(pushThreadRouteWithHistory).not.toHaveBeenCalled();
  });
  it.each(['approve', 'reject'] as const)('refuses %s while the containing read is locked', async (action) => {
    host = { ...host, writesLocked: true };
    await render();
    await act(async () => (action === 'approve' ? approve() : reject()).click());
    expect(posts()).toHaveLength(0);
  });
  it('checks current authority at the press, including a refusal after rendering', async () => {
    await render();
    vi.mocked(host.authorizeWrite).mockReturnValue(false);
    await act(async () => approve().click());
    expect(host.authorizeWrite).toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
  });
  it('keeps editing/cancel available during a locked read and reports its draft to the host', async () => {
    host = { ...host, writesLocked: true };
    await render();
    await act(async () => edit().click());
    expect(container.querySelectorAll('input,textarea').length).toBeGreaterThan(0);
    expect(host.reportEditing).toHaveBeenCalledWith('thread-proposal', true);
    await act(async () => (presentation === 'classic' ? button(/取消编辑/) : edit()).click());
    expect(host.reportEditing).toHaveBeenCalledWith('thread-proposal', false);
    expect(posts()).toHaveLength(0);
  });
});
