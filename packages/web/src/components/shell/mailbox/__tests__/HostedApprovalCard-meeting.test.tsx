/**
 * F322 S3-2b-1c: the F292 meeting-intake card, hosted in the 待办 panel.
 *
 * Unlike the generic cards it leaves no record in the Approval Hub store: it keeps its own busy and error state and tells
 * its host what its request saw. So everything the panel can say about a meeting-intake write comes from that report, and
 * the report says less than a status: "settled" is a 2xx or a deliberate stop between two requests, so the panel must not
 * word it as a response nor as the lack of one.
 */
import type { ApprovalHubItem } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { MailboxRead } from '../../unified-mailbox-state';
import type { UnifiedAttentionView } from '../../use-unified-attention';

vi.unmock('@/components/useConfirm');

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      threads: [
        {
          id: 'thread-1',
          title: 'F292 产品讨论',
          projectPath: '/workspace/cat-cafe',
          createdBy: 'owner-1',
          participants: ['codex-sol'],
          lastActiveAt: 200,
          createdAt: 100,
        },
      ],
      currentProjectPath: '/workspace/cat-cafe',
      isLoadingThreads: false,
    }),
}));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: vi.fn(async () => true) }));
vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName: string }) => cat.displayName,
  useCatData: () => ({ cats: [], isLoading: false }),
}));

import { ConfirmProvider } from '@/components/useConfirm';
import { HostedApprovalCard } from '../HostedApprovalCard';
import { resolveOriginalPlace } from '../original-place';
import { useApprovalSessions } from '../use-approval-sessions';
import { approvalRow, OWNER, okRead } from './mailbox-fixtures';

const MEETING: ApprovalHubItem = {
  proposalId: 'intake-1',
  sourceFeatureId: 'F292',
  requesterCatId: 'system',
  ownerUserId: OWNER,
  resolution: 'open',
  materialization: { state: 'not_started' },
  summary: '整理会议：Weekly sync',
  detail: {
    revision: 3,
    sourceState: 'ready',
    judgmentState: 'unresolved',
    executionState: 'idle',
    healthState: 'healthy',
    unresolved: [],
    choices: {
      speakerMap: { 1: 'You' },
      context: 'Architecture review',
      destinationHandle: 'host:private-thread:thread-1',
      outputs: ['minutes'],
    },
    metadata: { title: 'Weekly sync' },
    source: { handle: 'feishu://meeting-artifacts/minute/om_1?revision=3' },
  },
  navigation: { state: 'legacy_unanchored' },
  inlineApprovable: false,
  decisionMode: 'meeting-intake',
  createdAt: 1,
};

const place = resolveOriginalPlace(approvalRow(MEETING));

function fakeView() {
  const state = { started: 1, result: okRead([approvalRow(MEETING)]) as MailboxRead, generation: 1 as number | null };
  const refetch = vi.fn(() => {
    state.started += 1;
  });
  const view = (): UnifiedAttentionView => ({
    result: state.result,
    staleRead: null,
    refetch,
    readsStarted: () => state.started,
    resultGeneration: state.generation,
  });
  return { state, refetch, view };
}

let root: Root;
let container: HTMLDivElement;
let fake: ReturnType<typeof fakeView>;
let confirmResponse: () => Promise<Response>;
let settledItems: unknown[];

function Wrapper({ view }: { view: UnifiedAttentionView }) {
  const sessions = useApprovalSessions(view);
  return (
    <ConfirmProvider>
      <HostedApprovalCard
        item={approvalRow(MEETING)}
        ownerUserId={OWNER}
        sessions={sessions}
        place={place}
        onOpen={() => undefined}
      />
    </ConfirmProvider>
  );
}

const render = () => act(async () => root.render(<Wrapper view={fake.view()} />));
const $ = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const text = (testId: string) => $(testId)?.textContent ?? null;
const flush = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const confirm = () => act(async () => $('meeting-confirm')?.click());

async function answer(result: MailboxRead) {
  fake.state.result = result;
  fake.state.generation = fake.state.started;
  await render();
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  settledItems = [];
  confirmResponse = async () => Response.json({ intake: { revision: 4 } });
  mocks.apiFetch.mockImplementation((path: string) => {
    if (path === '/api/approval-hub/pending') return Promise.resolve(Response.json({ items: [MEETING], count: 1 }));
    if (path.startsWith('/api/approval-hub/settled')) return Promise.resolve(Response.json({ items: settledItems }));
    if (path === '/api/meeting-intakes/intake-1/confirm') return confirmResponse();
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
  useApprovalHubStore.setState({
    items: [MEETING],
    count: 1,
    decisionAttempts: {},
    deciding: {},
    error: null,
    isLoading: false,
  });
  fake = fakeView();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  useApprovalHubStore.setState({ items: [], count: 0, decisionAttempts: {}, deciding: {} });
});

describe('HostedApprovalCard: the meeting-intake card, reporting its own request', () => {
  it('shows the original meeting card when the store holds the same revision', async () => {
    await render();
    await flush();
    expect($('meeting-confirm')).not.toBeNull();
    expect($('mailbox-approval-unmatched')).toBeNull();
  });

  it('a 2xx is "operation ended, confirming", then 已批准 only with a settled row', async () => {
    await render();
    await flush();
    await confirm();
    await flush();
    expect(text('mailbox-approval-result')).toBe('操作已结束，正在确认结果…');
    expect(fake.refetch).toHaveBeenCalledTimes(1);

    settledItems = [
      { proposalId: 'intake-1', sourceFeatureId: 'F292', ownerUserId: OWNER, resolution: 'accepted', decidedAt: 9 },
    ];
    await answer(okRead([]));
    expect(text('mailbox-approval-result')).toContain('已批准');
    expect($('meeting-confirm')).toBeNull();
  });

  it('a 2xx whose re-read no longer lists it but has no settled row is not 已处理', async () => {
    await render();
    await flush();
    await confirm();
    await flush();
    await answer(okRead([]));
    expect(text('mailbox-approval-result')).toBe('已不在当前待办，结果待确认');
  });

  it('a 403 is "没有权限" and the card is held', async () => {
    confirmResponse = async () => Response.json({ error: 'forbidden' }, { status: 403 });
    await render();
    await flush();
    await confirm();
    await flush();
    expect(text('mailbox-approval-result')).toBe('没有权限');
    expect(($('meeting-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect($('mailbox-approval-reread')).not.toBeNull();
  });

  it('a 409 is an abnormal answer that is confirmed by a re-read, not a failure', async () => {
    confirmResponse = async () => Response.json({ error: 'revision_conflict' }, { status: 409 });
    await render();
    await flush();
    await confirm();
    await flush();
    expect(text('mailbox-approval-result')).toBe('请求返回异常，正在确认结果…');
  });

  it('no response at all is the only case worded as no response', async () => {
    confirmResponse = () => Promise.reject(new TypeError('offline'));
    await render();
    await flush();
    await confirm();
    await flush();
    expect(text('mailbox-approval-result')).toBe('没有收到回应，正在确认结果…');
  });

  it('asks the sessions before the request: a press on a changed copy sends nothing', async () => {
    await render();
    await flush();
    const button = $('meeting-confirm') as HTMLButtonElement;
    const changed: ApprovalHubItem = { ...MEETING, detail: { ...MEETING.detail, revision: 4 } };
    await act(async () => {
      useApprovalHubStore.setState({ items: [changed] });
      button.click();
    });
    await flush();
    const posted = mocks.apiFetch.mock.calls.some((call) => call[0] === '/api/meeting-intakes/intake-1/confirm');
    expect(posted).toBe(false);
    expect($('mailbox-approval-notice')).not.toBeNull();
  });
});
