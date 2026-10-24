import { createCatId, type ThreadProposal } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '@/components/ApprovalHost';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import type { RichCardBlock } from '@/stores/chat-types';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';
import { ProposalCard } from '../ProposalCard';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useThreadDisplayInfo', () => ({
  useThreadDisplayInfo: () => ({ currentThread: { id: 'source-thread', title: '界面设计的原对话' } }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => ({
      id: 'codex61-sol',
      displayName: '小太阳',
      breedDisplayName: '缅因猫',
      color: { primary: '#886644', secondary: '#ffeecc' },
    }),
  }),
}));
vi.mock('@/stores/chatStore', () => {
  const state = { threads: [], currentThreadId: 'source-thread' };
  const useChatStore = (selector: (value: typeof state) => unknown) => selector(state);
  useChatStore.getState = () => state;
  return { useChatStore };
});

const proposal: ThreadProposal = {
  proposalId: 'proposal-parity',
  status: 'pending',
  sourceThreadId: 'source-thread',
  sourceInvocationId: 'source-invocation',
  sourceCatId: createCatId('codex61-sol'),
  title: '把真实卡片放回对话',
  reason: '同一件事沿用同一张卡。',
  parentThreadId: 'source-thread',
  preferredCats: [createCatId('codex61-sol')],
  initialMessage: '**真相源**\n\n- 先读原对话\n- 保留原来的草稿',
  reportingMode: 'state-transitions',
  declaredWorkMode: 'subtask',
  projectPath: '/isolated/project/cat-cafe',
  createdBy: 'owner-proof',
  createdAt: 1,
  cardMessageId: 'source-card-message',
};
const block: RichCardBlock = {
  id: 'proposal-parity-card',
  kind: 'card',
  v: 1,
  title: `提议新建 thread：${proposal.title}`,
  fields: [
    { label: '父 Thread', value: proposal.parentThreadId },
    { label: '建议成员', value: 'codex61-sol' },
    { label: '项目归属', value: proposal.projectPath },
    { label: '回报模式', value: 'state-transitions' },
    { label: '首条消息', value: proposal.initialMessage! },
  ],
  actions: [{ label: '批准并创建', action: 'propose:approve', payload: { proposalId: proposal.proposalId } }],
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellPresentation('v2');
  useSidebarProjectionStore.setState({ rows: [] });
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async () => Response.json({ proposal }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  writeShellPresentation('classic');
  writeShellLanguage('zh');
  vi.unstubAllGlobals();
});
async function render(card: React.ReactNode) {
  await act(async () => root.render(card));
}

it('uses the Inbox producer card and human field names in the Chat entry', async () => {
  await render(<ProposalCard block={block} messageId="source-card-message" />);
  expect(host.querySelector(`[data-testid="approval-item-${proposal.proposalId}"]`)).not.toBeNull();
  for (const text of [
    '派给',
    '项目',
    '放进 Group',
    '回报',
    '置顶',
    '先开口',
    '界面设计的原对话',
    '每到一个阶段回报一次',
  ])
    expect(host.textContent).toContain(text);
  for (const raw of ['父 Thread', '建议成员', 'state-transitions', proposal.projectPath])
    expect(host.textContent).not.toContain(raw);
});

it('sends an inline change request to the proposer while preserving the formatted first message', async () => {
  await render(<ProposalCard proposal={proposal} />);
  expect(host.querySelector('[data-testid="proposal-initial-message"] strong')?.textContent).toBe('真相源');
  const revise = [...host.querySelectorAll('button')].find((button) => button.textContent === '让小太阳改…');
  expect(revise).toBeDefined();
  await act(async () => revise?.click());
  const input = host.querySelector<HTMLInputElement>('input[aria-label="想怎么改？"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '换 Argon 审');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
  const write = vi.mocked(apiFetch).mock.calls.find((call) => call[1]?.method === 'POST');
  expect(write?.[0]).toBe(`/api/proposals/${proposal.proposalId}/request-revision`);
  expect(JSON.parse(String(write?.[1]?.body))).toEqual({ instruction: '换 Argon 审' });
  expect(host.textContent).toContain('已发给提议的猫');
  expect(host.querySelector('[data-testid="proposal-initial-message"] strong')?.textContent).toBe('真相源');
});

it('lets a keyboard reader focus the bounded first-message region', async () => {
  await render(<ProposalCard proposal={proposal} />);
  const region = host.querySelector<HTMLElement>('[aria-label="第一条消息"]');
  expect(region).not.toBeNull();
  expect(region?.tabIndex).toBe(0);
  region?.focus();
  expect(document.activeElement).toBe(region);
});

it('offers existing projects from the canonical rows when the legacy thread cache is empty', async () => {
  useSidebarProjectionStore.setState({
    rows: [
      {
        id: 'other-project-thread',
        title: 'Existing project',
        participants: [],
        pinned: false,
        favorited: false,
        labels: [],
        preferredCats: [],
        projectPath: '/isolated/existing-project',
        lastActiveAt: 1,
        systemKind: null,
        isHubThread: false,
        unreadCount: 0,
        hasUserMention: false,
        presence: { status: 'idle' },
      },
    ],
  });
  await render(<ProposalCard proposal={proposal} />);
  const projects = host.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="项目"]');
  expect(projects).not.toBeNull();
  await act(async () => projects?.click());
  const option = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (option) => option.textContent?.trim() === 'existing-project',
  );
  expect(option).toBeDefined();
  await act(async () => option?.click());
  expect(projects?.textContent).toContain('existing-project');
  expect(document.activeElement).toBe(projects);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]')?.click());
  const write = vi.mocked(apiFetch).mock.calls.find((call) => call[1]?.method === 'POST');
  expect(JSON.parse(String(write?.[1]?.body)).projectPath).toBe('/isolated/existing-project');
});

it.each([
  true,
  false,
])('keeps a local revision draft editable while the host refuses writes (locked=%s)', async (locked) => {
  const authorizeWrite = vi.fn(() => false);
  await render(
    <ApprovalHostContext.Provider value={{ ...PERMISSIVE_APPROVAL_HOST, writesLocked: locked, authorizeWrite }}>
      <ProposalCard proposal={proposal} />
    </ApprovalHostContext.Provider>,
  );
  const revise = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '让小太阳改…',
  )!;
  expect(revise.disabled).toBe(false);
  await act(async () => revise.click());
  const input = host.querySelector<HTMLInputElement>('input[aria-label="想怎么改？"]')!;
  expect(input.disabled).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '换 Argon 审');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
  expect(vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
  expect(input.value).toBe('换 Argon 审');
});

it.each(['zh', 'en'] as const)('collapses an approved Chat proposal to the verified result in %s', async (language) => {
  writeShellLanguage(language);
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({
      proposal: { ...proposal, status: 'approved', createdThreadId: 'created-thread' },
    }),
  );
  await render(<ProposalCard block={block} messageId="source-card-message" />);
  const result = host.querySelector('[data-testid="thread-proposal-result"]');
  expect(result).not.toBeNull();
  expect(result?.querySelector('[data-testid="proposal-result-label"]')?.textContent).toBe(
    language === 'en' ? 'Approved · conversation opened' : '已同意 · 对话已开',
  );
  expect(result?.querySelector('[data-testid="proposal-result-dot"]')?.getAttribute('data-status')).toBe('approved');
  expect(result?.querySelector('[data-testid="proposal-result-open"]')?.textContent).toBe(
    language === 'en' ? 'Open ›' : '打开 ›',
  );
  expect(result?.querySelector('[href]')).toBeNull();
  expect(host.querySelector('[data-testid="proposal-result-details"]')).toBeNull();
  expect(host.textContent).not.toContain(proposal.reason);
  expect(host.textContent).not.toContain(proposal.title);
  expect(host.querySelector('[data-testid="approve-btn"]')).toBeNull();
  const toggle = result?.querySelector('button');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  await act(async () => toggle?.click());
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  expect(host.textContent).toContain(proposal.title);
  expect(host.textContent).toContain(proposal.reason);
  expect(host.querySelector('[data-testid="proposal-initial-message"]')).not.toBeNull();
  expect(host.textContent).toContain(language === 'en' ? 'Proposed by' : '谁提的');
  expect(vi.mocked(apiFetch).mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
});

it.each(['zh', 'en'] as const)('shows a declined result with the canonical decision time in %s', async (language) => {
  writeShellLanguage(language);
  const rejectedAt = new Date(2026, 9, 22, 5, 44).getTime();
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ proposal: { ...proposal, status: 'rejected', rejectedAt } }));
  await render(<ProposalCard block={block} messageId="source-card-message" />);
  const result = host.querySelector('[data-testid="thread-proposal-result"]');
  expect(result?.querySelector('[data-testid="proposal-result-label"]')?.textContent).toBe(
    language === 'en' ? 'Declined · 05:44' : '已拒绝 · 05:44',
  );
  expect(result?.querySelector('[data-testid="proposal-result-dot"]')?.getAttribute('data-status')).toBe('rejected');
  expect(result?.querySelector('a')).toBeNull();
  expect(host.querySelector('[data-testid="proposal-result-details"]')).toBeNull();
});

it('does not expose an old actionable engineering card when the original owner read refuses it', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ error: 'Not the current owner' }, { status: 403 }));
  await render(<ProposalCard block={block} messageId="source-card-message" />);
  expect(host.querySelector('[data-testid="approve-btn"]')).toBeNull();
  expect(host.textContent).not.toContain(proposal.projectPath);
  expect(vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
});

it.each([
  { proposalId: 'foreign-proposal' },
  { cardMessageId: 'foreign-card-message' },
  { sourceThreadId: 'foreign-thread' },
  { preferredCats: 'codex61-sol' },
])('refuses a producer response bound to a different card/source or invalid display fields: %j', async (change) => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ proposal: { ...proposal, ...change } }));
  await render(
    <ProposalCard
      block={block}
      messageId="source-card-message"
      coordinate={{ threadId: 'source-thread', messageId: 'source-card-message', messageRevision: 'source-revision' }}
    />,
  );
  expect(host.querySelector('[data-testid="approve-btn"]')).toBeNull();
  expect(host.querySelector(`[data-testid="approval-item-${proposal.proposalId}"]`)).toBeNull();
});

it('collapses a live terminal reread instead of trusting socket decision fields', async () => {
  await render(<ProposalCard block={block} messageId="source-card-message" />);
  expect(host.querySelector('[data-testid="approve-btn"]')).not.toBeNull();
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ proposal: { ...proposal, status: 'rejected' } }));
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('cat-cafe:proposal-updated', {
        detail: { proposalId: proposal.proposalId, status: 'approved', createdThreadId: 'forged-thread' },
      }),
    ),
  );
  expect(host.querySelector('[data-testid="proposal-result-label"]')?.textContent).toBe('已拒绝');
  expect(host.querySelector('[data-testid="proposal-result-details"]')).toBeNull();
  expect(host.querySelector('a')).toBeNull();
});

it('retains the host navigation fence on the result link, including a cold locked read', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({ proposal: { ...proposal, status: 'approved', createdThreadId: 'created-thread' } }),
  );
  const authorizeWrite = vi.fn(() => false);
  await render(
    <ApprovalHostContext.Provider value={{ ...PERMISSIVE_APPROVAL_HOST, writesLocked: true, authorizeWrite }}>
      <ProposalCard block={block} messageId="source-card-message" />
    </ApprovalHostContext.Provider>,
  );
  const link = host.querySelector<HTMLElement>('[data-testid="proposal-result-open"]');
  expect(link?.hasAttribute('href')).toBe(false);
  expect(link?.getAttribute('aria-disabled')).toBe('true');
  await act(async () => link?.click());
  expect(authorizeWrite).not.toHaveBeenCalled();
});

it('rereads the original decision after a local decline even without a socket notification', async () => {
  let declined = false;
  const rejectedAt = new Date(2026, 9, 22, 5, 44).getTime();
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      declined = true;
      return Response.json({ ok: true });
    }
    return Response.json({ proposal: declined ? { ...proposal, status: 'rejected', rejectedAt } : proposal });
  });
  await render(<ProposalCard block={block} messageId="source-card-message" />);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="reject-btn"]')?.click());
  expect(host.querySelector('[data-testid="proposal-result-label"]')?.textContent).toBe('已拒绝 · 05:44');
  expect(host.querySelector('[data-testid="proposal-result-details"]')).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
});

it.each([
  false,
  true,
])('keeps native navigation private and honors live continuation authority (%s)', async (allowed) => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({ proposal: { ...proposal, status: 'approved', createdThreadId: 'created-thread' } }),
  );
  const authorizeWrite = vi.fn(() => allowed);
  const navigate = vi.spyOn(window.history, 'pushState');
  await render(
    <ApprovalHostContext.Provider value={{ ...PERMISSIVE_APPROVAL_HOST, writesLocked: false, authorizeWrite }}>
      <ProposalCard block={block} messageId="source-card-message" />
    </ApprovalHostContext.Provider>,
  );
  expect(host.querySelector('[href]')).toBeNull();
  const link = host.querySelector<HTMLElement>('[data-testid="proposal-result-open"]');
  expect(link).not.toBeNull();
  await act(async () => {
    link?.click();
    link?.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    link?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  });
  expect(authorizeWrite).toHaveBeenCalledWith('producer-card', { continuation: true });
  if (allowed) expect(navigate).toHaveBeenCalledExactlyOnceWith({}, '', '/thread/created-thread');
  else expect(navigate).not.toHaveBeenCalled();
  navigate.mockRestore();
});
