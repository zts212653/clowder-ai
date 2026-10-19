import type { ApprovalHubItem, ThreadProposal } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApprovalHost, ApprovalHostContext } from '@/components/ApprovalHost';
import { approvalMemberCopy } from '@/components/rich/approval-member.shell-copy';
import { proposalCardCopy } from '@/components/rich/proposal-card.shell-copy';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';
import { checkShellCopyParity } from '../../__tests__/shell-copy-parity-check';
import { mailboxEntryCopy } from '../mailbox-entry.shell-copy';
import { ThreadProposalDecision } from '../ThreadProposalDecision';
import { threadProposalCopy } from '../thread-proposal.shell-copy';
import { storeItem } from './mailbox-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => () => '小太阳' }));
const registry = vi.hoisted(() => ({ known: true }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () =>
      registry.known
        ? {
            displayName: '小太阳',
            nickname: '砚砚',
            defaultModel: 'gpt-6.1-sol',
            avatar: '',
            color: { primary: 'var(--color-codex-primary)', secondary: 'var(--color-codex-bg)' },
          }
        : undefined,
  }),
}));
vi.mock('@/hooks/useThreadDisplayInfo', () => ({
  useThreadDisplayInfo: () => ({ currentThread: { title: 'Parent project discussion' } }),
}));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ refreshSidebarThreadSnapshot: vi.fn(async () => true) }));
vi.mock('@/stores/chatStore', () => {
  const state = { threads: [] };
  const useChatStore = (selector: (value: typeof state) => unknown) => selector(state);
  useChatStore.getState = () => state;
  return { useChatStore };
});
vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (state: unknown) => unknown) =>
    selector({ deciding: {}, approveProposal: vi.fn(), rejectProposal: vi.fn() }),
}));

const proposal: ThreadProposal = {
  proposalId: 'parity-proposal',
  status: 'pending',
  sourceThreadId: 'parent-id',
  sourceInvocationId: 'invocation',
  sourceCatId: 'codex61-sol' as ThreadProposal['sourceCatId'],
  title: 'Readable proposal',
  reason: 'Investigate the **actual evidence** before changing behavior.',
  parentThreadId: 'parent-id',
  preferredCats: ['codex61-sol' as ThreadProposal['sourceCatId']],
  initialMessage: '**Start here**\n\n- Read the source\n- Verify the result',
  projectPath: '/isolated',
  reportingMode: 'final-only',
  declaredWorkMode: 'investigation',
  createdBy: 'owner',
  createdAt: 1,
};
const item: ApprovalHubItem = {
  ...storeItem(),
  proposalId: proposal.proposalId,
  sourceFeatureId: 'F128',
  ownerUserId: 'owner',
  requesterCatId: proposal.sourceCatId,
  createdAt: 1,
  inlineApprovable: false,
  detail: {
    title: proposal.title,
    reason: proposal.reason,
    parentThreadId: proposal.parentThreadId,
    projectPath: proposal.projectPath,
    preferredCats: proposal.preferredCats,
    initialMessage: proposal.initialMessage,
    reportingMode: proposal.reportingMode,
  },
};
let container: HTMLDivElement;
let root: Root;
const host: ApprovalHost = {
  presentation: 'mailbox',
  writesLocked: false,
  authorizeWrite: () => true,
  reportEditing: vi.fn(),
  reportRequest: vi.fn(),
  originalPlaceAction: <button type="button">在原处打开</button>,
};
beforeEach(() => {
  useSidebarProjectionStore.setState({ rows: [], pendingThreadCommands: {}, hasCanonicalSnapshot: false });
  registry.known = true;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(apiFetch).mockReset().mockResolvedValue(Response.json({ proposal }));
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
        <ThreadProposalDecision item={item} />
      </ApprovalHostContext.Provider>,
    ),
  );
}
describe('the inbox uses the original new-conversation card capabilities', () => {
  it.each([
    'checked',
    'default',
    'unchecked',
  ])('submits initial pin=%s in the approval even if the card loses continuation authority', async (selection) => {
    const pinned = selection === 'checked';
    const originalAuthorize = host.authorizeWrite;
    host.authorizeWrite = (_kind, options) => !options?.continuation;
    vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
      Response.json(init?.method === 'POST' ? { threadId: 'created-thread' } : { proposal }),
    );
    try {
      await render();
      if (selection !== 'default')
        await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
      if (selection === 'unchecked')
        await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]')?.click());
      const posts = vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual(pinned ? { pinned: true } : {});
      expect(vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'PATCH')).toHaveLength(0);
    } finally {
      host.authorizeWrite = originalAuthorize;
    }
  });
  it('offers canonical parent alternatives when the narrow page has never mounted a sidebar', async () => {
    useSidebarProjectionStore.setState({
      rows: [
        {
          id: 'alternate-parent',
          title: 'Alternate verification discussion',
          projectPath: '/isolated',
          participants: [],
          pinned: false,
          favorited: false,
          labels: [],
          preferredCats: [],
          lastActiveAt: 1,
          systemKind: null,
          isHubThread: false,
          unreadCount: 0,
          hasUserMention: false,
          presence: { status: 'idle' },
        },
      ],
      hasCanonicalSnapshot: true,
    });
    await render();
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '编辑')?.click(),
    );
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="父对话"]');
    expect([...(select?.options ?? [])].map((option) => [option.value, option.textContent])).toContainEqual([
      'alternate-parent',
      'Alternate verification discussion',
    ]);
  });
  it('shows the assigned member name and actual model rather than its internal address', async () => {
    await render();
    const members = [...container.querySelectorAll('dt')].find((el) =>
      el.textContent?.startsWith('谁来做'),
    )?.nextElementSibling;
    expect(members?.textContent).toContain('砚砚');
    expect(members?.textContent).toContain('gpt-6.1-sol');
    expect(members?.textContent).not.toContain('codex61-sol');
  });
  it('says the member name is unavailable without displaying its address when the registry is missing', async () => {
    registry.known = false;
    await render();
    const members = [...container.querySelectorAll('dt')].find((el) =>
      el.textContent?.startsWith('谁来做'),
    )?.nextElementSibling;
    expect(members?.textContent).toContain('成员名称暂不可读');
    expect(members?.textContent).not.toContain('codex61-sol');
  });
  it.each([
    ['native card', proposalCardCopy],
    ['decision member', approvalMemberCopy],
    ['verified producer read', threadProposalCopy],
    ['row', mailboxEntryCopy],
  ] as const)('keeps the %s copy complete in both languages', (_name, copy) => {
    expect(checkShellCopyParity(copy)).toEqual([]);
  });
  it('cancels an inline edit with Escape without dismissing the containing panel', async () => {
    await render();
    const edit = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '编辑');
    await act(async () => edit?.click());
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => container.querySelector('input[type="text"]')?.dispatchEvent(event));
    expect(container.querySelectorAll('input[type="text"],textarea')).toHaveLength(0);
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector('button[data-testid="approve-btn"]')).not.toBeNull();
  });
  it('shows the actual follow-up policy after cancelling unsaved mode changes', async () => {
    await render();
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '编辑')?.click(),
    );
    const mode = container.querySelector<HTMLSelectElement>('select[aria-label="回报方式"]');
    await act(async () => {
      if (mode) {
        mode.value = 'none';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '取消修改')?.click(),
    );
    expect(container.textContent).toContain('只回最终结果');
    expect(container.textContent).not.toContain('不回报');
  });
  it('can edit every original field and opt in to pinning without opening Chat', async () => {
    await render();
    const edit = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '编辑');
    expect(edit).toBeDefined();
    await act(async () => edit?.click());
    expect(container.querySelectorAll('input[type="text"],textarea')).toHaveLength(5);
    expect(container.querySelectorAll('select')).toHaveLength(3);
    const parent = container.querySelector<HTMLSelectElement>('select[aria-label="父对话"]');
    expect(parent?.selectedOptions[0]?.textContent).toBe('Parent project discussion');
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
  });
  it('formats the initial task as Markdown inside a disclosure while main actions stay outside', async () => {
    await render();
    const details = container.querySelector('details[data-testid="proposal-initial-message"]');
    expect(details).not.toBeNull();
    expect(details?.querySelector('strong')?.textContent).toBe('Start here');
    expect(details?.querySelector('button[data-testid="approve-btn"]')).toBeNull();
    expect(container.querySelector('button[data-testid="approve-btn"]')).not.toBeNull();
  });
  it('shows the actual parent title instead of a thread identifier', async () => {
    await render();
    expect(container.textContent).toContain('Parent project discussion');
    expect(container.textContent).not.toContain('parent-id');
  });
});
