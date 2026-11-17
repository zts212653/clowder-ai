import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { reconcileThreadWithServer } from '@/hooks/queue-reconciliation';
import { apiFetch } from '@/utils/api-client';
import { useChatOwnerBindings } from '../useChatOwnerBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/queue-reconciliation', () => ({ reconcileThreadWithServer: vi.fn(async () => {}) }));
afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const revision = `sha256:${'1'.repeat(64)}`;

it('pulls the visible vote once, refreshes on vote events, holds its base on reappear and ends through its owner', async () => {
  const data = fixtureData();
  window.clowderChat = { dataOk: vi.fn(), dataError: vi.fn() } as unknown as typeof window.clowderChat;
  let needed: boolean | number = false,
    commit!: () => void;
  let vote = { question: 'Owner question', status: 'active', votes: { owner: 'yes' } };
  vi.mocked(apiFetch).mockImplementation(async () => response({ vote }));
  const hook = renderHook(() => {
    const [, refresh] = useState(0);
    commit = () => refresh((n) => n + 1);
    return useChatOwnerBindings(data, false, needed);
  });
  await act(async () => {});
  expect(apiFetch).not.toHaveBeenCalled();
  needed = 1;
  await act(commit);
  expect(hook.result.current.data.vote.value?.question).toBe('Owner question');
  expect(apiFetch).toHaveBeenCalledTimes(1);
  vi.useFakeTimers();
  try {
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
  } finally {
    vi.useRealTimers();
  }
  expect(apiFetch).toHaveBeenCalledTimes(1);
  vote = { ...vote, votes: { owner: 'no' } };
  await act(async () =>
    window.dispatchEvent(new CustomEvent('cat-cafe:vote-updated', { detail: { threadId: data.threadId } })),
  );
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(hook.result.current.data.vote.value?.votes).toEqual({ owner: 'no' });
  needed = false;
  await act(commit);
  await act(async () =>
    window.dispatchEvent(new CustomEvent('cat-cafe:vote-updated', { detail: { threadId: data.threadId } })),
  );
  expect(apiFetch).toHaveBeenCalledTimes(2);
  const held = hook.result.current.data.vote;
  let finish!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  needed = 2;
  await act(commit);
  expect(hook.result.current.data.vote).toBe(held);
  await act(async () => finish(response({ vote: null })));
  expect(hook.result.current.data.vote.value).toBeNull();
  vi.mocked(apiFetch).mockResolvedValue(response({ status: 'closed' }));
  await act(() => hook.result.current.action('cafeVoteEnd', {}));
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/threads/pdl-test/vote',
    expect.objectContaining({ method: 'DELETE' }),
    undefined,
  );
});

it('reads frustration and custody owners on message data changes and preserves the string source revision in decisions', async () => {
  const data = fixtureData();
  data.messages[0].extra = {
    custodyOfferV1: {
      offerId: 'offer',
      sourceMessageRevision: revision,
      policyVersion: 'v1',
      reasonCode: 'entrusted',
      disposition: 'pending',
    },
  };
  data.messages[1].source = { connector: 'frustration-auto-issue', label: 'Issue', icon: 'alert' };
  data.messages[1].extra = {
    rich: {
      v: 1,
      blocks: [
        {
          v: 1,
          id: 'issue-card',
          kind: 'card',
          title: 'Issue',
          meta: { kind: 'frustration_auto_issue', issueId: 'issue' },
        },
      ],
    },
  };
  let status = 'draft',
    disposition = 'pending';
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'POST') {
      if (String(path).endsWith('/confirm')) status = 'confirmed';
      if (String(path).endsWith('/refuse')) disposition = 'declined';
      return response({ ok: true });
    }
    return response(
      String(path).includes('frustration-issues')
        ? { issue: { issueId: 'issue', status } }
        : { offer: { offerId: 'offer', disposition }, sourceMessageRevision: revision },
    );
  });
  const hook = renderHook(() => useChatOwnerBindings(data, true));
  await waitFor(() => expect(Object.keys(hook.result.current.data.proposals)).toHaveLength(2));
  await act(() =>
    hook.result.current.action('proposalOwnerDecide', { mid: 'reply-1', op: 'confirm', v: 'Exact description' }),
  );
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/frustration-issues/issue/confirm',
    expect.objectContaining({ body: JSON.stringify({ userDescription: 'Exact description' }) }),
    undefined,
  );
  expect(hook.result.current.data.proposals['reply-1'].value?.issue?.status).toBe('confirmed');
  await act(() =>
    hook.result.current.action('proposalOwnerDecide', {
      mid: 'user-1',
      op: 'refuse',
      offerId: 'offer',
      sourceMessageRevision: revision,
    }),
  );
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/messages/user-1/custody-offer/refuse',
    expect.objectContaining({
      body: JSON.stringify({ offerId: 'offer', sourceMessageRevision: revision, disposition: 'declined' }),
    }),
    undefined,
  );
  expect(hook.result.current.data.proposals['user-1'].value?.offer?.disposition).toBe('declined');
});

it('keeps a proposal failure on its own card and refreshes its authoritative owner', async () => {
  const data = fixtureData();
  data.messages[0].extra = {
    custodyOfferV1: {
      offerId: 'offer',
      sourceMessageRevision: revision,
      policyVersion: 'v1',
      reasonCode: 'entrusted',
      disposition: 'pending',
    },
  };
  let failed = true;
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'POST'
      ? response({ error: 'Source changed' }, 409)
      : failed
        ? response({ error: 'Owner unavailable' }, 503)
        : response({ offer: null, sourceMessageRevision: revision }),
  );
  const hook = renderHook(() => useChatOwnerBindings(data, true));
  await waitFor(() => expect(hook.result.current.data.proposals['user-1']?.error).toBe('Owner unavailable'));
  await act(async () =>
    expect(
      await hook.result.current.action('proposalOwnerDecide', {
        mid: 'user-1',
        op: 'accept',
        offerId: 'offer',
        sourceMessageRevision: revision,
      }),
    ).toEqual({ ok: false }),
  );
  expect(hook.result.current.data.proposalErrors['user-1']).toBe('Source changed');
  failed = false;
  await act(() => hook.result.current.action('proposalOwnerRefresh', { mid: 'user-1' }));
  expect(hook.result.current.data.proposalErrors['user-1']).toBe('');
  expect(hook.result.current.data.proposals['user-1'].value?.offer).toBeNull();
});

it('reads exact queue targets, writes the selected mapping, reorders with PATCH and refreshes authoritative queue state', async () => {
  const value = {
    cats: {
      participants: [{ catId: 'codex' }],
      routableNow: [{ catId: 'codex' }],
      routableNotJoined: [{ catId: 'new' }],
    },
    source: {
      sourceRecordId: 'source',
      targets: [
        { targetCatId: 'codex', actionable: true },
        { targetCatId: 'done', actionable: false },
      ],
    },
  };
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    response(String(path).endsWith('/cats') ? value.cats : String(path).endsWith('/targets') ? value.source : {}),
  );
  const hook = renderHook(() => useChatOwnerBindings(fixtureData()));
  await act(() => hook.result.current.action('queueTargetsRead', { threadId: 'pdl-test', entryId: 'queue /1' }));
  expect(hook.result.current.data.queueTargets[JSON.stringify(['pdl-test', 'queue /1'])].value).toEqual(value);
  const mapping = {
    sourceRecordId: 'source',
    observedPendingTargetIds: ['codex'],
    targets: [{ targetCatId: 'new', strategy: 'interrupt_reply', membershipAtOpen: 'admit' }],
  };
  await act(() =>
    hook.result.current.action('queueTargetsSave', {
      threadId: 'pdl-test',
      entryId: 'queue /1',
      value: JSON.stringify(mapping),
    }),
  );
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/threads/pdl-test/queue/queue%20%2F1/targets',
    expect.objectContaining({ method: 'POST', body: JSON.stringify(mapping) }),
    undefined,
  );
  await act(() => hook.result.current.action('cafeQueueOrder', { keys: JSON.stringify(['second', 'first']) }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/threads/pdl-test/queue/reorder',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({
        positions: [
          { entryId: 'second', position: 0 },
          { entryId: 'first', position: 1 },
        ],
      }),
    }),
    undefined,
  );
  expect(reconcileThreadWithServer).toHaveBeenCalledTimes(2);
});

it('reveals whispers on the chosen thread and reconciles that thread after its acknowledgement', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ revealed: 2 }));
  const hook = renderHook(() => useChatOwnerBindings(fixtureData()));
  await act(() => hook.result.current.action('cafeReveal', { id: 'other/thread' }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/threads/other%2Fthread/reveal',
    expect.objectContaining({ method: 'PATCH', body: '{}' }),
    undefined,
  );
  expect(reconcileThreadWithServer).toHaveBeenCalledWith('other/thread', expect.any(Function), 'PdlReveal');
});

it('holds message bundle content and tombstones from the real bundle owner, including retry failures', async () => {
  const bundle = {
    messageBundleId: 'bundle',
    items: [
      { status: 'available', readableContent: 'Original quote', from: { kind: 'user', userId: 'owner' } },
      { status: 'tombstone', messageId: 'removed', reason: 'source_changed' },
    ],
  };
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(bundle))
    .mockResolvedValueOnce(response({ error: 'Bundle unavailable' }, 404));
  const hook = renderHook(() => useChatOwnerBindings(fixtureData()));
  await act(() => hook.result.current.action('messageBundleOpen', { id: 'bundle' }));
  expect(hook.result.current.data.bundles.bundle.value).toEqual(bundle);
  await act(() => hook.result.current.action('messageBundleOpen', { id: 'bundle' }));
  expect(hook.result.current.data.bundles.bundle).toMatchObject({ load: 'error', error: 'Bundle unavailable' });
});

it('reads each routing target independently and retains repeat receipts and write failures per target', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    response(
      String(path).endsWith('/repeat')
        ? { status: 'repeated', messageId: 'repeat-message', entryId: 'repeat-entry' }
        : String(path).endsWith('/bad') || (String(path).endsWith('/retry') && init?.method === 'POST')
          ? { error: 'Target changed' }
          : { status: 'failed' },
      String(path).endsWith('/bad') || String(path).endsWith('/retry') ? 409 : 200,
    ),
  );
  const hook = renderHook(() => useChatOwnerBindings(fixtureData()));
  const source = { threadId: 'pdl-test', sourceMessageId: 'user-1' },
    key = JSON.stringify(['pdl-test', 'user-1']);
  await act(() =>
    hook.result.current.action('cafeDeliveryRead', { ...source, targets: JSON.stringify(['codex', 'bad']) }),
  );
  expect(hook.result.current.data.delivery[key].codex.value?.status).toBe('failed');
  expect(hook.result.current.data.delivery[key].bad.error).toBe('Target changed');
  await act(() => hook.result.current.action('cafeDeliveryRecover', { ...source, targetCatId: 'codex', op: 'repeat' }));
  expect(hook.result.current.data.repeatReceipts[key].codex).toEqual({
    status: 'repeated',
    messageId: 'repeat-message',
    entryId: 'repeat-entry',
  });
  await act(() => hook.result.current.action('cafeDeliveryRecover', { ...source, targetCatId: 'bad', op: 'retry' }));
  expect(hook.result.current.data.deliveryErrors[key].bad).toBe('Target changed');
  expect(reconcileThreadWithServer).toHaveBeenCalledTimes(1);
});

it('uses the real onboarding owner for admission and all four lifecycle receipts', async () => {
  let demo = { status: 'not_started', autoEligible: true },
    entry = { status: 'not_started' };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT') {
      const status = JSON.parse(String(init.body)).status as string;
      if (String(path).endsWith('/entry')) entry = { status };
      else demo = { ...demo, status };
    }
    return response(String(path).endsWith('/entry') ? entry : demo);
  });
  const hook = renderHook(() => useChatOwnerBindings(fixtureData()));
  await act(() => hook.result.current.action('guideAdmission', {}));
  expect(hook.result.current.data.onboarding).toEqual({ demo, entry });
  await act(() => hook.result.current.action('guideNext', {}));
  expect(hook.result.current.data.onboarding?.demo.status).toBe('completed');
  expect(hook.result.current.data.onboarding?.entry.status).toBe('pending');
  for (const name of ['guideEntryDismiss', 'guideEntryComplete', 'guideDismiss'])
    await act(() => hook.result.current.action(name, {}));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/config/onboarding/entry',
    expect.objectContaining({ method: 'PUT', body: '{"status":"completed"}' }),
    undefined,
  );
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/config/onboarding',
    expect.objectContaining({ method: 'PUT', body: '{"status":"dismissed"}' }),
    undefined,
  );
});

it('does not advance the guide when the completion write fails', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ error: 'Preference revision unavailable' }, 503));
  const hook = renderHook(() => useChatOwnerBindings(fixtureData()));
  await act(async () => {
    await expect(hook.result.current.action('guideNext', {})).rejects.toThrow('Preference revision unavailable');
  });
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('hides only the callback tuple and marks the telemetry snapshot actually opened', async () => {
  const data = fixtureData(),
    meta = {
      kind: 'callback_auth_failure',
      reason: 'revoked',
      tool: 'write',
      catId: 'codex',
      threadId: 'pdl-test',
      userId: 'owner',
      failedAt: 1,
    };
  data.messages[1].extra = { rich: { v: 1, blocks: [{ v: 1, id: 'cb', kind: 'card', title: 'Auth', meta }] } };
  data.messages[1].source = { connector: 'callback-auth' } as never; // the card is the callback-auth connector's (message-cards)
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    response(init?.method ? { ok: true } : { startedAt: 100, uptimeMs: 25 }),
  );
  const hook = renderHook(() => useChatOwnerBindings(data, true));
  await act(() => hook.result.current.action('cbAuthHideSimilar', { mid: 'reply-1' }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/debug/callback-auth/hide-similar',
    expect.objectContaining({
      body: JSON.stringify({ reason: 'revoked', tool: 'write', catId: 'codex', threadId: 'pdl-test', userId: 'owner' }),
    }),
    undefined,
  );
  await act(() => hook.result.current.action('cbAuthViewed', {}));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/debug/callback-auth/mark-viewed',
    expect.objectContaining({ body: '{"viewedUpTo":125}' }),
    undefined,
  );
});

it('reads the source-specific disposition page and writes personal ignore coordinates unchanged', async () => {
  const page = { bundles: [{ bundleKey: 'source-bundle' }] };
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => response(init?.method ? { ok: true } : page));
  const hook = renderHook(() => useChatOwnerBindings(fixtureData()));
  await act(() => hook.result.current.action('msgDisposition', { mid: 'message /1' }));
  expect(hook.result.current.data.pawSource).toEqual({ messageId: 'message /1', page });
  expect(apiFetch).toHaveBeenCalledWith('/api/paw-feel/source/message%20%2F1', undefined, undefined);
  const ignore = {
    expectedOwnerUserId: 'owner',
    expectedRevision: 4,
    ignore: [{ messageId: 'message /1' }],
    restore: [],
  };
  await act(() => hook.result.current.action('inboxIgnore', { value: JSON.stringify(ignore) }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/config/ignored-items',
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify(ignore) }),
    undefined,
  );
});
