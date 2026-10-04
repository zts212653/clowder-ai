/**
 * F322 S3-2b-1c: the original approval card, hosted in the 待办 panel, from the press of a button to a result it can stand
 * behind. Real Approval Hub store, real sessions hook, real original card; only the network is faked.
 *
 * What must hold:
 *  - the card is the original one and acts through the original store and endpoint; nothing here approves anything;
 *  - it appears only when the store holds the same decision the read shows, and says why not when it does not;
 *  - a press is refused (nothing sent) when the displayed read and the store no longer agree;
 *  - after a write the card says only what a re-read of both sources proved: 已处理 only with a settled row, otherwise still
 *    open, unconfirmed, no permission or login needed, each with 重新读取;
 *  - the store's optimistic removal on a 2xx does not make the card vanish mid-confirmation, and is not a result.
 */
import type { ApprovalHubItem } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEndpoint } from '@/stores/approval-decision-http';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { MailboxRead } from '../../unified-mailbox-state';
import type { UnifiedAttentionView } from '../../use-unified-attention';
import { resolveOriginalPlace } from '../original-place';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/stores/chatStore', () => {
  const useChatStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ threads: [], currentThreadId: null });
  useChatStore.getState = () => ({ threads: [], currentThreadId: null });
  return { useChatStore };
});
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: () => ({}), kickTeleportResolve: vi.fn() }));
vi.mock('../../../ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

import { HostedApprovalCard } from '../HostedApprovalCard';
import { useApprovalSessions } from '../use-approval-sessions';
import { approvalRow, OWNER, okRead, storeItem } from './mailbox-fixtures';

const item = storeItem();
const place = resolveOriginalPlace(approvalRow(item));

/** The read hook's view, with a count that moves on its own the instant a read starts. */
function fakeView() {
  const state = { started: 1, result: okRead([approvalRow(item)]) as MailboxRead, generation: 1 as number | null };
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

interface Network {
  pending: ApprovalHubItem[];
  approve: () => Promise<Response>;
  settled: () => Promise<Response>;
}

const calls = () => mocks.apiFetch.mock.calls.map((call) => `${call[1]?.method ?? 'GET'} ${call[0] as string}`);

function route(network: Network) {
  mocks.apiFetch.mockImplementation((path: string) => {
    if (path === '/api/approval-hub/pending') {
      return Promise.resolve(Response.json({ items: network.pending, count: network.pending.length }));
    }
    if (path.startsWith('/api/approval-hub/settled')) return network.settled();
    if (path.endsWith('/approve')) return network.approve();
    return Promise.reject(new Error(`unexpected request ${path}`));
  });
}

let root: Root;
let container: HTMLDivElement;
let fake: ReturnType<typeof fakeView>;
const onOpen = vi.fn();

function Wrapper({ view }: { view: UnifiedAttentionView }) {
  const sessions = useApprovalSessions(view);
  return (
    <HostedApprovalCard
      item={approvalRow(item)}
      ownerUserId={OWNER}
      sessions={sessions}
      place={place}
      onOpen={onOpen}
    />
  );
}

const render = () => act(async () => root.render(<Wrapper view={fake.view()} />));
const $ = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const text = (testId: string) => $(testId)?.textContent ?? null;
const flush = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** The re-read that was started last answers, and React commits it. */
async function answer(result: MailboxRead) {
  fake.state.result = result;
  fake.state.generation = fake.state.started;
  await render();
  await flush();
}

const gone = () => okRead([]);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  onOpen.mockReset();
  useApprovalHubStore.setState({
    items: [item],
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

describe('HostedApprovalCard: the original card, when it may be shown', () => {
  it('shows the original card when the store holds the same decision, and refreshes the store to be sure', async () => {
    route({
      pending: [item],
      approve: async () => new Response(null, { status: 500 }),
      settled: async () => Response.json({ items: [] }),
    });
    await render();
    await flush();
    expect($('approve-btn')).not.toBeNull();
    expect($('reject-btn')).not.toBeNull();
    expect(calls()).toContain('GET /api/approval-hub/pending');
    expect($('mailbox-approval-unmatched')).toBeNull();
  });

  it('does not show it when the store holds a different version, and says so without guessing', async () => {
    const other = storeItem({ summary: 'someone changed it' });
    useApprovalHubStore.setState({ items: [other] });
    route({
      pending: [other],
      approve: async () => new Response(null, { status: 500 }),
      settled: async () => Response.json({ items: [] }),
    });
    await render();
    await flush();
    expect($('approve-btn')).toBeNull();
    expect($('mailbox-approval-unmatched')?.getAttribute('data-reason')).toBe('version');
    // The way to the original place is still there.
    expect($('mailbox-open-original')).not.toBeNull();
  });

  it('says it is checking while the store has not answered, instead of calling the decision unmatched', async () => {
    useApprovalHubStore.setState({ items: [] });
    let finish: () => void = () => undefined;
    mocks.apiFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(Response.json({ items: [item], count: 1 }));
        }),
    );
    await render();
    expect($('mailbox-approval-checking')).not.toBeNull();
    expect($('mailbox-approval-unmatched')).toBeNull();
    await act(async () => finish());
    await flush();
    expect($('mailbox-approval-checking')).toBeNull();
    expect($('approve-btn')).not.toBeNull();
  });

  it('always keeps the way to the original place', async () => {
    route({
      pending: [item],
      approve: async () => new Response(null, { status: 500 }),
      settled: async () => Response.json({ items: [] }),
    });
    await render();
    await flush();
    await act(async () => $('mailbox-open-original')?.click());
    expect(onOpen).toHaveBeenCalledWith(place);
  });
});

describe('HostedApprovalCard: a press, and what comes back', () => {
  it('approve → submitted → re-read of both sources → 已批准 only with a settled row', async () => {
    let release: (response: Response) => void = () => undefined;
    const network: Network = {
      pending: [item],
      approve: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      settled: async () =>
        Response.json({
          items: [
            {
              proposalId: 'p-1',
              sourceFeatureId: 'F128',
              ownerUserId: OWNER,
              resolution: 'accepted',
              decidedAt: 1_700_000_000_000,
              decidedBy: OWNER,
            },
          ],
        }),
    };
    route(network);
    await render();
    await flush();
    await act(async () => $('approve-btn')?.click());
    // Exactly where the Approval Hub itself would post: the original store resolves the producer's endpoint.
    expect(calls()).toContain(`POST ${resolveEndpoint('F128', 'p-1', 'approve')}`);
    expect(text('mailbox-approval-result')).toBe('正在提交…');
    expect(($('approve-btn') as HTMLButtonElement).disabled).toBe(true);

    // The server has the decision now: its pending list no longer holds it.
    network.pending = [];
    await act(async () => release(Response.json({ ok: true })));
    await flush();
    // The store removed the item optimistically: the card is still here, held, and nothing is claimed yet.
    expect(text('mailbox-approval-result')).toBe('已提交，正在确认结果…');
    expect($('approve-btn')).not.toBeNull();
    expect(fake.refetch).toHaveBeenCalledTimes(1);

    await answer(gone());
    expect(text('mailbox-approval-result')).toContain('已批准');
    expect($('approve-btn')).toBeNull();
    expect($('mailbox-approval-reread')).toBeNull();
  });

  it('a 2xx followed by a read that does not list it and no settled row is NOT 已处理', async () => {
    let release: (response: Response) => void = () => undefined;
    const network: Network = {
      pending: [item],
      approve: () => new Promise<Response>((resolve) => (release = resolve)),
      settled: async () => Response.json({ items: [] }),
    };
    route(network);
    await render();
    await flush();
    await act(async () => $('approve-btn')?.click());
    network.pending = [];
    await act(async () => release(Response.json({ ok: true })));
    await flush();
    await answer(gone());
    expect(text('mailbox-approval-result')).toBe('已不在当前待办，结果待确认');
    expect(text('mailbox-approval-result')).not.toContain('已批准');
    expect($('mailbox-approval-reread')).not.toBeNull();
  });

  it('a lost connection is unknown; the re-read the user asks for can settle it', async () => {
    let fail = true;
    route({
      pending: [item],
      approve: () => (fail ? Promise.reject(new TypeError('network')) : Promise.resolve(Response.json({ ok: true }))),
      settled: async () =>
        Response.json({
          items: [
            { proposalId: 'p-1', sourceFeatureId: 'F128', ownerUserId: OWNER, resolution: 'accepted', decidedAt: 5 },
          ],
        }),
    });
    await render();
    await flush();
    await act(async () => $('approve-btn')?.click());
    await flush();
    expect(text('mailbox-approval-result')).toBe('没有收到回应，正在确认结果…');
    await answer(okRead([approvalRow(item)]));
    expect(text('mailbox-approval-result')).toBe('没能确认提交结果，重新读取后仍待决定');

    fail = false;
    await act(async () => $('mailbox-approval-reread')?.click());
    expect(fake.refetch).toHaveBeenCalledTimes(2);
    await answer(gone());
    expect(text('mailbox-approval-result')).toContain('已批准');
  });

  it('a 403 says no permission, holds the card, and offers a re-read', async () => {
    route({
      pending: [item],
      approve: async () => Response.json({ error: 'forbidden' }, { status: 403 }),
      settled: async () => Response.json({ items: [] }),
    });
    await render();
    await flush();
    await act(async () => $('approve-btn')?.click());
    await flush();
    expect(text('mailbox-approval-result')).toBe('没有权限');
    expect(($('approve-btn') as HTMLButtonElement).disabled).toBe(true);
    expect($('mailbox-approval-reread')).not.toBeNull();
    expect(fake.refetch).not.toHaveBeenCalled();
  });

  it('a press on a copy that is no longer the decision in the store sends nothing, says so, and re-reads', async () => {
    const changed = storeItem({ summary: 'changed elsewhere' });
    route({
      pending: [item],
      approve: async () => Response.json({ ok: true }),
      settled: async () => Response.json({ items: [] }),
    });
    await render();
    await flush();
    const button = $('approve-btn') as HTMLButtonElement;
    expect(button).not.toBeNull();
    route({
      pending: [changed],
      approve: async () => Response.json({ ok: true }),
      settled: async () => Response.json({ items: [] }),
    });
    const before = calls().length;
    // The store's copy changes and the press lands in the same breath, before React has re-rendered the card.
    await act(async () => {
      useApprovalHubStore.setState({ items: [changed] });
      button.click();
    });
    await flush();
    expect(
      calls()
        .slice(before)
        .some((call) => call.startsWith('POST')),
    ).toBe(false);
    expect($('mailbox-approval-notice')).not.toBeNull();
    expect(fake.refetch).toHaveBeenCalledTimes(1);
  });
});
