/**
 * F322 S3-2b-1c: the F292 meeting-intake repair is two requests, and the panel must let the second one go.
 *
 * "Save the destination's cat, then retry delivery" is one action of the original card: it PATCHes the thread, then asks its
 * host again right before the retry. A host that refuses every request while a write is in flight cuts the action in half
 * (found by an independent review of the first version: only the PATCH went out). The next request of a write the host
 * already let out is judged by whether anything the user was looking at has moved since, and a new press is still locked.
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
          // No cat takes part yet: the repair has to save one before delivery can be retried.
          participants: [],
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
  useCatData: () => ({
    cats: [{ id: 'codex-sol', displayName: 'Sol', roster: { available: true } }],
    isLoading: false,
  }),
}));

import { ApprovalItemCard } from '@/components/ApprovalItemCard';
import { ConfirmProvider } from '@/components/useConfirm';
import { HostedApprovalCard } from '../HostedApprovalCard';
import { resolveOriginalPlace } from '../original-place';
import { useApprovalSessions } from '../use-approval-sessions';
import { approvalRow, OWNER, okRead } from './mailbox-fixtures';

const REVISION_3: ApprovalHubItem = {
  proposalId: 'intake-1',
  sourceFeatureId: 'F292',
  requesterCatId: 'system',
  ownerUserId: OWNER,
  resolution: 'open',
  materialization: { state: 'not_started' },
  summary: '整理会议：Weekly sync',
  detail: {
    revision: 3,
    repair: { code: 'route_unavailable', action: 'retry' },
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
const REVISION_4: ApprovalHubItem = { ...REVISION_3, detail: { ...REVISION_3.detail, revision: 4 } };

const PATCH_PATH = '/api/threads/thread-1';
const RETRY_PATH = '/api/meeting-intakes/intake-1/retry';
const place = resolveOriginalPlace(approvalRow(REVISION_3));

function fakeView() {
  const state = {
    started: 1,
    result: okRead([approvalRow(REVISION_3)]) as MailboxRead,
    generation: 1 as number | null,
  };
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
/** What the thread PATCH does when it arrives: it may change the world, or hold its answer. */
let onPatch: () => Promise<Response>;

function Wrapper({ view }: { view: UnifiedAttentionView }) {
  const sessions = useApprovalSessions(view);
  return (
    <ConfirmProvider>
      <HostedApprovalCard
        item={approvalRow(REVISION_3)}
        ownerUserId={OWNER}
        sessions={sessions}
        place={place}
        onOpen={() => undefined}
      />
    </ConfirmProvider>
  );
}

const $ = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const text = (testId: string) => $(testId)?.textContent ?? null;
const flush = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const writes = () =>
  mocks.apiFetch.mock.calls
    .filter((call) => call[1]?.method === 'PATCH' || call[1]?.method === 'POST')
    .map((call) => `${call[1].method} ${call[0] as string}`);

async function openRepair() {
  await act(async () => root.render(<Wrapper view={fake.view()} />));
  await flush();
  await act(async () => $('meeting-workflow-cat-codex-sol')?.click());
}
const pressRepair = () => act(async () => $('meeting-bind-cat-retry')?.click());

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  onPatch = async () => Response.json({ ok: true });
  mocks.apiFetch.mockImplementation((path: string) => {
    if (path === '/api/approval-hub/pending') {
      return Promise.resolve(Response.json({ items: [REVISION_3], count: 1 }));
    }
    if (path.startsWith('/api/approval-hub/settled')) return Promise.resolve(Response.json({ items: [] }));
    if (path === PATCH_PATH) return onPatch();
    if (path === RETRY_PATH) return Promise.resolve(Response.json({ intake: { revision: 4 } }));
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
  useApprovalHubStore.setState({
    items: [REVISION_3],
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

describe('the meeting repair, hosted in the 待办 panel', () => {
  it('control: the same original card outside the panel sends the save and the retry', async () => {
    await act(async () =>
      root.render(
        <ConfirmProvider>
          <ApprovalItemCard item={REVISION_3} />
        </ConfirmProvider>,
      ),
    );
    await flush();
    await act(async () => $('meeting-workflow-cat-codex-sol')?.click());
    await pressRepair();
    await flush();
    expect(writes()).toEqual([`PATCH ${PATCH_PATH}`, `POST ${RETRY_PATH}`]);
  });

  it('when nothing the user was looking at has moved, the retry follows the save', async () => {
    await openRepair();
    expect(($('meeting-bind-cat-retry') as HTMLButtonElement).disabled).toBe(false);
    await pressRepair();
    await flush();
    expect(writes()).toEqual([`PATCH ${PATCH_PATH}`, `POST ${RETRY_PATH}`]);
    // The panel then follows the one action it let out, and says only that it ended until the re-read answers.
    expect(text('mailbox-approval-result')).toBe('操作已结束，正在确认结果…');
    expect(fake.refetch).toHaveBeenCalledTimes(1);
  });

  it('stops after the save when the Approval Hub now holds another revision', async () => {
    onPatch = async () => {
      useApprovalHubStore.setState({ items: [REVISION_4] });
      return Response.json({ ok: true });
    };
    await openRepair();
    await pressRepair();
    await flush();
    expect(writes()).toEqual([`PATCH ${PATCH_PATH}`]);
    // Stopped on purpose: the panel still reads both sources before it says anything.
    expect(text('mailbox-approval-result')).toBe('操作已结束，正在确认结果…');
    expect(fake.refetch).toHaveBeenCalledTimes(1);
  });

  it('stops after the save when the Approval Hub no longer holds the decision', async () => {
    onPatch = async () => {
      useApprovalHubStore.setState({ items: [] });
      return Response.json({ ok: true });
    };
    await openRepair();
    await pressRepair();
    await flush();
    expect(writes()).toEqual([`PATCH ${PATCH_PATH}`]);
  });

  it('stops after the save when a newer read has started in the meantime', async () => {
    onPatch = async () => {
      // An invalidation starts a new read while the save is out; the read on screen is no longer the current one.
      fake.state.started += 1;
      return Response.json({ ok: true });
    };
    await openRepair();
    await pressRepair();
    await flush();
    expect(writes()).toEqual([`PATCH ${PATCH_PATH}`]);
  });

  it('a second press while the save is out sends nothing of its own', async () => {
    let release: (response: Response) => void = () => undefined;
    onPatch = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    await openRepair();
    await pressRepair();
    await pressRepair();
    expect(writes()).toEqual([`PATCH ${PATCH_PATH}`]);
    await act(async () => release(Response.json({ ok: true })));
    await flush();
    // The one action finishes as one action: a single save, a single retry.
    expect(writes()).toEqual([`PATCH ${PATCH_PATH}`, `POST ${RETRY_PATH}`]);
  });
});
