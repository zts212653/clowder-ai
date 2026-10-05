/**
 * F322 S3-2b-1c: the driver that follows an approval hosted in the 待办 panel from the press of a button to a result it can
 * stand behind.
 *
 * The reconciler (pure) decides what may be said; this is the part that makes its inputs true:
 *  - it follows only attempts made after the session opened, against this exact item;
 *  - when a write has ended it starts a new unified read AND refreshes the Approval Hub store, and judges only a read that
 *    began after the write ended (a generation of the panel's own reads, not a clock);
 *  - it never declares "已处理" from the store's optimistic removal or from absence from a page: only a settled row for this
 *    owner, producer and proposal does that;
 *  - it is asked synchronously, right before each producer write, whether the displayed read and the store still agree.
 */
import type { ApprovalHubItem } from '@cat-cafe/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionAttempt, DecisionAttemptState } from '@/stores/approval-decision-attempts';
import type { MailboxRead } from '../../unified-mailbox-state';
import { describeReconcile, type SettledLookup } from '../approval-reconcile';
import { type ApprovalSession, createApprovalSessions, sessionKey } from '../approval-sessions';
import { approvalRow, NOW, OWNER, okRead, storeItem, visibleApproval } from './mailbox-fixtures';

const ADDRESS = { sourceFeatureId: 'F128', proposalId: 'p-1' };
const KEY = sessionKey(OWNER, ADDRESS);

const accepted200: DecisionAttemptState = { phase: 'response_received', status: 200, ok: true };
const found = (resolution: 'accepted' | 'rejected' | 'closed_without_decision' = 'accepted'): SettledLookup => ({
  kind: 'found',
  terminal: { resolution, decidedAt: 9, decidedBy: OWNER },
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(options: { items?: ApprovalHubItem[]; attempts?: Record<string, DecisionAttempt> } = {}) {
  const item = storeItem();
  let started = 1;
  let latest: { result: MailboxRead; generation: number | null } = {
    result: okRead([approvalRow(item)]),
    generation: 1,
  };
  let store: ApprovalHubItem[] = options.items ?? [item];
  let attempts: Record<string, DecisionAttempt> = options.attempts ?? {};
  let settled: SettledLookup = { kind: 'not_found' };
  let refresh: () => Promise<void> = async () => undefined;

  const deps = {
    readsStarted: () => started,
    refetch: vi.fn(() => {
      started += 1;
      latest = { result: { kind: 'loading' }, generation: null };
    }),
    refreshStore: vi.fn(() => refresh()),
    storeItems: () => store,
    attempts: () => attempts,
    latestRead: () => latest,
    now: () => NOW,
    lookupSettled: vi.fn(async () => settled),
  };
  const sessions = createApprovalSessions(deps);
  const open = () =>
    sessions.open({ ownerUserId: OWNER, decisionRef: 'approval:p-1', approval: visibleApproval(item) });

  return {
    item,
    deps,
    sessions,
    open,
    state: () => (sessions.get(KEY) as ApprovalSession).model.state,
    view: () => describeReconcile((sessions.get(KEY) as ApprovalSession).model.state),
    setStore: (next: ApprovalHubItem[]) => {
      store = next;
    },
    setSettled: (next: SettledLookup) => {
      settled = next;
    },
    setRefresh: (next: () => Promise<void>) => {
      refresh = next;
    },
    attempt(attemptId: number, state: DecisionAttemptState, overrides: Partial<DecisionAttempt> = {}) {
      attempts = {
        ...attempts,
        'p-1': {
          attemptId,
          action: 'approve',
          sourceFeatureId: 'F128',
          createdAt: item.createdAt,
          state,
          ...overrides,
        },
      };
      sessions.attemptsChanged();
    },
    /** The reread that was started last answers. */
    async answer(result: MailboxRead) {
      latest = { result, generation: started };
      sessions.readSettled();
      await tick();
    },
    answerWithGeneration(result: MailboxRead, generation: number) {
      latest = { result, generation };
      sessions.readSettled();
      return tick();
    },
    latest: () => latest,
  };
}

const listed = (h: ReturnType<typeof harness>) => okRead([approvalRow(h.item)]);
const gone = () => okRead([]);

describe('open', () => {
  it('starts an idle session for this owner, producer and proposal, and keeps what was shown', () => {
    const h = harness();
    const session = h.open();
    expect(session.key).toBe(KEY);
    expect(session.ownerUserId).toBe(OWNER);
    expect(session.address).toEqual(ADDRESS);
    expect(session.decisionRef).toBe('approval:p-1');
    expect(session.approval.summary).toBe(h.item.summary);
    expect(session.model.state).toEqual({ kind: 'idle' });
    expect(h.sessions.list()).toHaveLength(1);
  });

  it('is idempotent: opening again keeps the session and its progress', async () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'submitting' });
    const again = h.open();
    expect(again.model.state.kind).toBe('writing');
    expect(h.sessions.list()).toHaveLength(1);
  });

  it('does not replay an attempt made before it opened (an earlier 403 from the Hub is not this card’s answer)', () => {
    const old: DecisionAttempt = {
      attemptId: 5,
      action: 'approve',
      sourceFeatureId: 'F128',
      createdAt: 500_000,
      state: { phase: 'response_received', status: 403, ok: false },
    };
    const h = harness({ attempts: { 'p-1': old } });
    h.open();
    h.sessions.attemptsChanged();
    expect(h.state()).toEqual({ kind: 'idle' });
    // The next attempt is followed.
    h.attempt(6, { phase: 'submitting' });
    expect(h.state().kind).toBe('writing');
  });

  it('ignores an attempt made against another version of the proposal', () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'submitting' }, { createdAt: 123 });
    expect(h.state()).toEqual({ kind: 'idle' });
    h.attempt(2, { phase: 'submitting' }, { sourceFeatureId: 'F221' });
    expect(h.state()).toEqual({ kind: 'idle' });
  });

  it('ignores an attempt that cannot say which item it was made against', () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'submitting' }, { sourceFeatureId: undefined, createdAt: undefined });
    expect(h.state()).toEqual({ kind: 'idle' });
  });
});

describe('a write, then a re-read of both sources', () => {
  it('holds the card while the request is in flight and starts no read yet', () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'submitting' });
    expect(h.state()).toEqual({ kind: 'writing', attemptId: 1 });
    expect(h.view()).toMatchObject({ line: '正在提交…', actions: 'held' });
    expect(h.deps.refetch).not.toHaveBeenCalled();
  });

  it('when the request ends it starts one new unified read and one store refresh, and says nothing yet', () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'submitting' });
    h.attempt(1, accepted200);
    expect(h.state()).toMatchObject({ kind: 'confirming', afterGeneration: 1 });
    expect(h.deps.refetch).toHaveBeenCalledTimes(1);
    expect(h.deps.refreshStore).toHaveBeenCalledTimes(1);
    expect(h.view()).toMatchObject({ line: '已提交，正在确认结果…', actions: 'held' });
  });

  it('is decided only when the re-read no longer lists it AND the settled history has the row', async () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'submitting' });
    h.attempt(1, accepted200);
    h.setSettled(found('accepted'));
    await h.answer(gone());
    expect(h.state()).toMatchObject({ kind: 'decided', terminal: { resolution: 'accepted' } });
    expect(h.view().actions).toBe('gone');
    expect(h.deps.lookupSettled).toHaveBeenCalledWith({
      ownerUserId: OWNER,
      sourceFeatureId: 'F128',
      proposalId: 'p-1',
    });
  });

  it('says a closed-without-decision row is exactly that (a withdrawn or expired proposal is not "已批准")', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    h.setSettled(found('closed_without_decision'));
    await h.answer(gone());
    expect(h.view().line).toContain('已结束，没有做决定');
  });

  it('is still open when the re-read lists it again and the store holds the same decision', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    await h.answer(listed(h));
    expect(h.state()).toMatchObject({ kind: 'still_open' });
    expect(h.view()).toMatchObject({ actions: 'allowed', canReread: true });
    expect(h.deps.lookupSettled).not.toHaveBeenCalled();
  });

  it('is NOT decided when it left a complete page but no settled row exists (the optimistic removal proves nothing)', async () => {
    const h = harness();
    h.open();
    // The store removed it optimistically on the 2xx.
    h.setStore([]);
    h.attempt(1, accepted200);
    h.setSettled({ kind: 'not_found' });
    await h.answer(gone());
    expect(h.state()).toEqual({ kind: 'unconfirmed', why: 'left_the_list' });
    expect(h.view().line).toBe('已不在当前待办，结果待确认');
  });

  it('cannot tell when the page was not read in full, even if it no longer lists it', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    await h.answer(okRead([], { page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: true } }));
    expect(h.state()).toEqual({ kind: 'unconfirmed', why: 'cannot_tell' });
  });

  it('cannot tell when the settled history is unavailable', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    h.setSettled({ kind: 'unavailable' });
    await h.answer(gone());
    expect(h.state()).toEqual({ kind: 'unconfirmed', why: 'left_the_list' });
    expect(h.state().kind).not.toBe('decided');
  });

  it('after a lost connection it is unknown, then a re-read the user asks for can settle it', async () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'transport_unknown' });
    expect(h.view().line).toBe('没有收到回应，正在确认结果…');
    await h.answer(listed(h));
    expect(h.state()).toMatchObject({ kind: 'still_open', write: { outcome: 'unknown' } });
    expect(h.view().line).toBe('没能确认提交结果，重新读取后仍待决定');

    h.sessions.reread(KEY);
    expect(h.state().kind).toBe('confirming');
    expect(h.deps.refetch).toHaveBeenCalledTimes(2);
    expect(h.deps.refreshStore).toHaveBeenCalledTimes(2);

    h.setSettled(found('accepted'));
    await h.answer(gone());
    expect(h.state()).toMatchObject({ kind: 'decided', terminal: { resolution: 'accepted' } });
  });

  it('a 403 is "没有权限" without a read, and a re-read afterwards is allowed', async () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'response_received', status: 403, ok: false });
    expect(h.state().kind).toBe('no_permission');
    expect(h.deps.refetch).not.toHaveBeenCalled();
    expect(h.view().canReread).toBe(true);
    h.sessions.reread(KEY);
    expect(h.deps.refetch).toHaveBeenCalledTimes(1);
    await h.answer(listed(h));
    expect(h.state().kind).toBe('still_open');
  });

  it('a 401 is "需要登录", and a re-read that is itself unauthenticated says so', async () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'response_received', status: 401, ok: false });
    expect(h.state().kind).toBe('needs_login');
    h.sessions.reread(KEY);
    await h.answer({ kind: 'failed', reason: 'unauthenticated' });
    expect(h.state().kind).toBe('needs_login');
  });

  it('a request refused before anything was sent is allowed to try again, with no read', () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'client_validation', reason: 'missing feedback' });
    expect(h.state().kind).toBe('refused_before_send');
    expect(h.deps.refetch).not.toHaveBeenCalled();
    expect(h.view().actions).toBe('allowed');
  });

  it('a 409 is not proof of anything: it is confirmed by the re-read like any other answer', async () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'response_received', status: 409, ok: false });
    expect(h.state()).toMatchObject({ kind: 'confirming', write: { outcome: 'errored', status: 409 } });
    await h.answer(listed(h));
    expect(h.view().line).toBe('请求返回异常，重新读取后仍待决定');
  });

  it('a read that failed is "结果暂未确认", not a result', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    await h.answer({ kind: 'failed', reason: 'unavailable' });
    expect(h.state()).toEqual({ kind: 'unconfirmed', why: 'read_failed' });
  });

  it('a read of another owner proves nothing about this card', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    await h.answer(okRead([], { identity: { ownerUserId: 'owner-2' } }));
    expect(h.state()).toEqual({ kind: 'unconfirmed', why: 'cannot_tell' });
    expect(h.deps.lookupSettled).not.toHaveBeenCalled();
  });

  it('still listed but not the same decision as the store: not aligned, until a re-read after a store refresh', async () => {
    const h = harness();
    h.open();
    h.setStore([]);
    h.attempt(1, accepted200);
    await h.answer(listed(h));
    expect(h.state()).toEqual({ kind: 'unconfirmed', why: 'not_aligned' });
    expect(h.view().actions).toBe('held');

    h.setStore([h.item]);
    h.sessions.reread(KEY);
    await h.answer(listed(h));
    expect(h.state().kind).toBe('still_open');
  });

  it('judges alignment only after the store refresh has finished', async () => {
    const h = harness();
    h.open();
    h.setStore([]);
    let finish: () => void = () => undefined;
    h.setRefresh(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            h.setStore([h.item]);
            resolve();
          };
        }),
    );
    h.attempt(1, accepted200);
    await h.answer(listed(h));
    // The read is in, the store is not: nothing is judged yet.
    expect(h.state().kind).toBe('confirming');
    finish();
    await tick();
    expect(h.state().kind).toBe('still_open');
  });

  it('a store refresh that fails does not hide the read: alignment is judged on what the store holds', async () => {
    const h = harness();
    h.open();
    h.setRefresh(async () => {
      throw new Error('offline');
    });
    h.attempt(1, accepted200);
    await h.answer(listed(h));
    // The store still holds the same decision, so it is aligned; had it lost it, it would not be.
    expect(h.state().kind).toBe('still_open');
  });
});

describe('reads that must not count', () => {
  it('a read that started at or before the write ended says nothing about the write', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    expect(h.state()).toMatchObject({ kind: 'confirming', afterGeneration: 1 });
    // A read numbered 1 was already in flight when the write ended.
    await h.answerWithGeneration(gone(), 1);
    expect(h.state().kind).toBe('confirming');
  });

  it('a loading read is not an answer', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    await tick();
    h.sessions.readSettled();
    await tick();
    expect(h.state().kind).toBe('confirming');
  });

  it('the same read delivered twice is judged once', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    h.setSettled(found('accepted'));
    const generation = h.deps.readsStarted();
    await h.answerWithGeneration(gone(), generation);
    await h.answerWithGeneration(gone(), generation);
    expect(h.deps.lookupSettled).toHaveBeenCalledTimes(1);
  });

  it('a slower, older answer cannot overwrite a newer read’s', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    let release: (value: SettledLookup) => void = () => undefined;
    h.deps.lookupSettled.mockImplementationOnce(
      () =>
        new Promise<SettledLookup>((resolve) => {
          release = resolve;
        }),
    );
    // Read 2 says it is gone and waits on a slow settled history.
    await h.answerWithGeneration(gone(), 2);
    expect(h.state().kind).toBe('confirming');
    // A newer read (3) starts and lists it again, before the slow history answers.
    h.deps.refetch();
    await h.answerWithGeneration(listed(h), 3);
    expect(h.state().kind).toBe('still_open');
    // The slow, older answer finally arrives: it is dropped.
    release(found('accepted'));
    await tick();
    expect(h.state().kind).toBe('still_open');
  });

  it('an older answer that lands while a newer read is on its way is dropped, not allowed to shadow what the newer read proves', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    let release: (value: SettledLookup) => void = () => undefined;
    h.deps.lookupSettled.mockImplementationOnce(
      () =>
        new Promise<SettledLookup>((resolve) => {
          release = resolve;
        }),
    );
    // Read 2 no longer lists it and waits on a slow settled history that will say "nothing found".
    await h.answerWithGeneration(gone(), 2);
    // Read 3 begins.
    h.deps.refetch();
    release({ kind: 'not_found' });
    await tick();
    // Had the old, weaker answer been applied, the session would no longer be waiting and read 3 would be ignored.
    expect(h.state().kind).toBe('confirming');
    h.setSettled(found('accepted'));
    await h.answerWithGeneration(gone(), 3);
    expect(h.state()).toMatchObject({ kind: 'decided', terminal: { resolution: 'accepted' } });
  });

  it('a new attempt replaces the old follow-up: an answer for the first write cannot dress up the second', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    h.attempt(2, { phase: 'submitting' });
    expect(h.state()).toEqual({ kind: 'writing', attemptId: 2 });
    h.setSettled(found('accepted'));
    await h.answer(gone());
    expect(h.state().kind).toBe('writing');
  });
});

describe('producers whose card reports its own request (meeting intake)', () => {
  it('follows start and end of a meeting-intake write like an attempt', async () => {
    const h = harness();
    h.open();
    h.sessions.hostReport(KEY, { phase: 'start', kind: 'meeting-intake' });
    expect(h.state().kind).toBe('writing');
    h.sessions.hostReport(KEY, { phase: 'end', kind: 'meeting-intake', outcome: 'settled' });
    // A card that says only "settled" cannot say it saw a response, nor that it saw none.
    expect(h.state()).toMatchObject({ kind: 'confirming', write: { outcome: 'ended' } });
    expect(h.view().line).toBe('操作已结束，正在确认结果…');
    expect(h.deps.refetch).toHaveBeenCalledTimes(1);
    await h.answer(listed(h));
    expect(h.state().kind).toBe('still_open');
    expect(h.view().line).toBe('操作已结束，重新读取后仍待决定');
  });

  it('an http error without a readable status is an ended operation, not a refusal and not a lost connection', () => {
    for (const status of [undefined, 0, 99, 600, Number.NaN]) {
      const h = harness();
      h.open();
      h.sessions.hostReport(KEY, { phase: 'start', kind: 'meeting-intake' });
      h.sessions.hostReport(KEY, { phase: 'end', kind: 'meeting-intake', outcome: 'http-error', status });
      expect(h.state()).toMatchObject({ kind: 'confirming', write: { outcome: 'ended' } });
    }
  });

  it('carries the status the card saw: 403 is no permission, 409 is an abnormal answer to confirm', () => {
    const h = harness();
    h.open();
    h.sessions.hostReport(KEY, { phase: 'start', kind: 'meeting-intake' });
    h.sessions.hostReport(KEY, { phase: 'end', kind: 'meeting-intake', outcome: 'http-error', status: 403 });
    expect(h.state().kind).toBe('no_permission');

    const h2 = harness();
    h2.open();
    h2.sessions.hostReport(KEY, { phase: 'start', kind: 'meeting-intake' });
    h2.sessions.hostReport(KEY, { phase: 'end', kind: 'meeting-intake', outcome: 'http-error', status: 409 });
    expect(h2.state()).toMatchObject({ kind: 'confirming', write: { outcome: 'errored', status: 409 } });
  });

  it('a lost connection is unknown, not a refusal', () => {
    const h = harness();
    h.open();
    h.sessions.hostReport(KEY, { phase: 'start', kind: 'meeting-intake' });
    h.sessions.hostReport(KEY, { phase: 'end', kind: 'meeting-intake', outcome: 'network-error' });
    expect(h.state()).toMatchObject({ kind: 'confirming', write: { outcome: 'unknown' } });
  });

  it('does not follow the store-backed kinds: the store’s own attempt says what happened to those', () => {
    const h = harness();
    h.open();
    h.sessions.hostReport(KEY, { phase: 'start', kind: 'approve' });
    h.sessions.hostReport(KEY, { phase: 'end', kind: 'approve', outcome: 'settled' });
    expect(h.state()).toEqual({ kind: 'idle' });
  });
});

describe('authorizeWrite: asked synchronously right before every producer write', () => {
  it('allows a card that is idle, shown from a current read, and the same decision as the store', () => {
    const h = harness();
    h.open();
    expect(h.sessions.authorize(KEY)).toBe(true);
    expect(h.sessions.get(KEY)?.notice).toBeNull();
  });

  it('is a plain boolean, decided now', () => {
    const h = harness();
    h.open();
    expect(typeof h.sessions.authorize(KEY)).toBe('boolean');
  });

  it('refuses while a write is in flight or being confirmed', () => {
    const h = harness();
    h.open();
    h.attempt(1, { phase: 'submitting' });
    expect(h.sessions.authorize(KEY)).toBe(false);
    h.attempt(1, accepted200);
    expect(h.sessions.authorize(KEY)).toBe(false);
  });

  it('refuses when the read behind the card is being replaced, and asks for a fresh one', () => {
    const h = harness();
    h.open();
    h.deps.refetch();
    h.deps.refetch.mockClear();
    expect(h.sessions.authorize(KEY)).toBe(false);
    expect(h.sessions.get(KEY)?.notice).toEqual(expect.any(String));
    expect(h.deps.refreshStore).toHaveBeenCalledTimes(1);
  });

  it('refuses when the displayed read is another owner’s', () => {
    const h = harness();
    h.open();
    h.latest().result = okRead([approvalRow(h.item)], { identity: { ownerUserId: 'owner-2' } });
    expect(h.sessions.authorize(KEY)).toBe(false);
  });

  it('refuses a card opened for one owner after the session changed hands, even when the store now holds the new owner’s copy', () => {
    const h = harness();
    h.open();
    // The same page is now owner-2's: its read lists a proposal at the same address and the Hub store holds owner-2's copy.
    const theirs = storeItem({ ownerUserId: 'owner-2' });
    h.setStore([theirs]);
    h.latest().result = okRead([approvalRow(theirs)], { identity: { ownerUserId: 'owner-2' } });
    expect(h.sessions.authorize(KEY)).toBe(false);
  });

  it('refuses when the read no longer lists it', () => {
    const h = harness();
    h.open();
    h.latest().result = gone();
    expect(h.sessions.authorize(KEY)).toBe(false);
  });

  it('refuses when the store’s copy is no longer the decision the user is looking at, then re-reads both', () => {
    const h = harness();
    h.open();
    h.setStore([storeItem({ summary: 'someone changed it' })]);
    expect(h.sessions.authorize(KEY)).toBe(false);
    expect(h.deps.refetch).toHaveBeenCalledTimes(1);
    expect(h.deps.refreshStore).toHaveBeenCalledTimes(1);
    expect(h.sessions.get(KEY)?.notice).toEqual(expect.any(String));
  });

  it('refuses a copy that has expired by now', () => {
    const h = harness();
    h.open();
    const expired = storeItem({ expiresAt: NOW - 1 });
    h.setStore([expired]);
    h.latest().result = okRead([approvalRow(expired)]);
    expect(h.sessions.authorize(KEY)).toBe(false);
  });

  it('allows again after an answer that left it open, and after a refusal before send', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    await h.answer(listed(h));
    expect(h.state().kind).toBe('still_open');
    expect(h.sessions.authorize(KEY)).toBe(true);

    const h2 = harness();
    h2.open();
    h2.attempt(1, { phase: 'client_validation', reason: 'x' });
    expect(h2.sessions.authorize(KEY)).toBe(true);
  });

  it('refuses after no permission, a login requirement or an unconfirmed result', async () => {
    for (const state of [
      { phase: 'response_received', status: 403, ok: false },
      { phase: 'response_received', status: 401, ok: false },
    ] as DecisionAttemptState[]) {
      const h = harness();
      h.open();
      h.attempt(1, state);
      expect(h.sessions.authorize(KEY)).toBe(false);
    }
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    await h.answer({ kind: 'failed', reason: 'unavailable' });
    expect(h.sessions.authorize(KEY)).toBe(false);
  });

  it('refuses a session it does not know, and one that was closed', () => {
    const h = harness();
    expect(h.sessions.authorize(KEY)).toBe(false);
    h.open();
    h.sessions.close(KEY);
    expect(h.sessions.authorize(KEY)).toBe(false);
  });

  it('forgets the refusal notice when the next write starts', () => {
    const h = harness();
    h.open();
    h.setStore([]);
    expect(h.sessions.authorize(KEY)).toBe(false);
    expect(h.sessions.get(KEY)?.notice).not.toBeNull();
    h.setStore([h.item]);
    h.attempt(1, { phase: 'submitting' });
    expect(h.sessions.get(KEY)?.notice).toBeNull();
  });
});

describe('subscribing and closing', () => {
  it('tells subscribers when a session changes, and not when nothing did', () => {
    const h = harness();
    const listener = vi.fn();
    const stop = h.sessions.subscribe(listener);
    h.open();
    const afterOpen = listener.mock.calls.length;
    expect(afterOpen).toBeGreaterThan(0);
    const version = h.sessions.getVersion();

    h.sessions.attemptsChanged();
    expect(listener).toHaveBeenCalledTimes(afterOpen);
    expect(h.sessions.getVersion()).toBe(version);

    h.attempt(1, { phase: 'submitting' });
    expect(listener.mock.calls.length).toBeGreaterThan(afterOpen);
    expect(h.sessions.getVersion()).toBeGreaterThan(version);

    stop();
    const calls = listener.mock.calls.length;
    h.attempt(1, accepted200);
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('closing forgets a session, and closing what is not there does nothing', () => {
    const h = harness();
    h.open();
    h.sessions.close(KEY);
    expect(h.sessions.get(KEY)).toBeUndefined();
    expect(h.sessions.list()).toEqual([]);
    expect(() => h.sessions.close(KEY)).not.toThrow();
  });

  it('a follow-up still in flight for a closed session is dropped', async () => {
    const h = harness();
    h.open();
    h.attempt(1, accepted200);
    h.sessions.close(KEY);
    h.setSettled(found('accepted'));
    await h.answer(gone());
    expect(h.sessions.get(KEY)).toBeUndefined();
  });
});

describe('authorizeWrite for the next request of a write that is already out (F292 saves a cat, then retries delivery)', () => {
  const CONTINUE = { continuation: true } as const;

  /** A write that was allowed and has begun, the way the card does it: ask, then announce the start. */
  function writeInFlight() {
    const h = harness();
    h.open();
    expect(h.sessions.authorize(KEY)).toBe(true);
    h.sessions.hostReport(KEY, { phase: 'start', kind: 'meeting-intake' });
    expect(h.state().kind).toBe('writing');
    return h;
  }

  it('lets the next request go when nothing the user was looking at has moved', () => {
    const h = writeInFlight();
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(true);
    // The same write goes on: asking again is not a result, and says nothing new to the user.
    expect(h.state().kind).toBe('writing');
    expect(h.sessions.get(KEY)?.notice).toBeNull();
  });

  it('is still refused as a new press: a press while a write is in flight is locked', () => {
    const h = writeInFlight();
    expect(h.sessions.authorize(KEY)).toBe(false);
    expect(h.sessions.authorize(KEY, { continuation: false })).toBe(false);
    // Refusing the press did not forget the write that is in flight.
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(true);
  });

  it('cannot continue a write that is not in flight', () => {
    const h = harness();
    h.open();
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
    // Allowed once, but never begun.
    expect(h.sessions.authorize(KEY)).toBe(true);
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('cannot continue a write this host never let go out', () => {
    const h = harness();
    h.open();
    // Another surface (the Approval Hub's own card) is writing the same proposal.
    h.attempt(1, { phase: 'submitting' });
    expect(h.state().kind).toBe('writing');
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('cannot continue once the write has ended or been replaced', () => {
    const h = writeInFlight();
    h.sessions.hostReport(KEY, { phase: 'end', kind: 'meeting-intake', outcome: 'settled' });
    expect(h.state().kind).toBe('confirming');
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('stops when a newer read has started since the write was allowed', () => {
    const h = writeInFlight();
    h.deps.refetch();
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('stops when a newer read has already settled, even one that lists the same decision: it is not the read the write was allowed against', () => {
    const h = writeInFlight();
    h.deps.refetch();
    h.latest().result = listed(h);
    h.latest().generation = h.deps.readsStarted();
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('does not carry an allowance over from a write that ended without a re-read', () => {
    const h = writeInFlight();
    // A 403 ends the write and starts no read, so the read on screen is still the one the write was allowed against.
    h.sessions.hostReport(KEY, { phase: 'end', kind: 'meeting-intake', outcome: 'http-error', status: 403 });
    expect(h.state().kind).toBe('no_permission');
    expect(h.deps.refetch).not.toHaveBeenCalled();
    // Another surface now writes the same proposal. This host never let that write out.
    h.attempt(5, { phase: 'submitting' });
    expect(h.state().kind).toBe('writing');
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('stops when the store now holds a different version of the decision', () => {
    const h = writeInFlight();
    h.setStore([storeItem({ summary: 'someone changed it' })]);
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('stops when the store no longer holds it', () => {
    const h = writeInFlight();
    h.setStore([]);
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('stops when the read on screen is another owner’s', () => {
    const h = writeInFlight();
    const theirs = storeItem({ ownerUserId: 'owner-2' });
    h.setStore([theirs]);
    h.latest().result = okRead([approvalRow(theirs)], { identity: { ownerUserId: 'owner-2' } });
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('stops when the read on screen no longer lists it', () => {
    const h = writeInFlight();
    h.latest().result = gone();
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('stops when the decision has expired in the meantime', () => {
    const h = writeInFlight();
    const expired = storeItem({ expiresAt: NOW - 1 });
    h.setStore([expired]);
    h.latest().result = okRead([approvalRow(expired)]);
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('a later write is judged by what was current when it was allowed, not by an earlier one', () => {
    const h = writeInFlight();
    h.sessions.hostReport(KEY, { phase: 'end', kind: 'meeting-intake', outcome: 'settled' });
    // The user reads again and presses again: a fresh allowance for a fresh write.
    h.sessions.reread(KEY);
    expect(h.state().kind).toBe('confirming');
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });

  it('forgets a closed session’s allowance', () => {
    const h = writeInFlight();
    h.sessions.close(KEY);
    expect(h.sessions.authorize(KEY, CONTINUE)).toBe(false);
  });
});
