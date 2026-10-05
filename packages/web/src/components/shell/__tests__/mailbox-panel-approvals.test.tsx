/**
 * F322 S3-2b-1c: the approvals that can be decided inside the 待办 panel, in the panel and its rows.
 *
 * The hosted card and the sessions driver have their own suites; here is only the panel's part:
 *  - a decidable approval's open row hosts the original card, anything else keeps its single way to the original place;
 *  - a row with a session says where it stands even when it is collapsed (an unknown is not shown as nothing);
 *  - when the read no longer lists a decision that has a result, the result stays as its own row until the user dismisses
 *    it, only for the person who made it, and it is never counted in the number on the rail.
 */
import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalRow, OWNER, okRead, storeItem } from '../mailbox/__tests__/mailbox-fixtures';
import { INITIAL_RECONCILE, type ReconcileState } from '../mailbox/approval-reconcile';
import type { ApprovalSession, ApprovalSessions } from '../mailbox/approval-sessions';
import { sessionKey } from '../mailbox/approval-sessions';
import type { MailboxRead } from '../unified-mailbox-state';

const data = vi.hoisted(() => ({
  view: {
    result: { kind: 'loading' } as unknown,
    staleRead: null as unknown,
    refetch: vi.fn(),
    readsStarted: () => 1,
    resultGeneration: 1 as number | null,
  },
  sessions: null as unknown,
  navigate: vi.fn(),
  hostedProps: [] as unknown[],
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/thread/current', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (s: (v: { setWorkspaceMode: () => void }) => unknown) => s({ setWorkspaceMode: vi.fn() }),
}));
vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (s: (v: { fetchPending: () => void }) => unknown) => s({ fetchPending: vi.fn() }),
}));
vi.mock('../mailbox/open-exact-place', () => ({ openExactPlace: data.navigate }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (catId: string) => `猫:${catId}` }));
vi.mock('../use-unified-attention', () => ({ useUnifiedAttention: () => data.view }));
vi.mock('../mailbox/use-approval-sessions', () => ({ useApprovalSessions: () => data.sessions }));
vi.mock('../mailbox/HostedApprovalCard', () => ({
  HostedApprovalCard: (props: { item: UnifiedAttentionItemV1; ownerUserId: string }) => {
    data.hostedProps.push(props);
    return <div data-testid="hosted-card-stub" data-owner={props.ownerUserId} data-ref={props.item.decisionRef} />;
  },
}));

import { MailboxButton } from '../MailboxButton';

const item = storeItem();
const row = approvalRow(item);
const KEY = sessionKey(OWNER, { sourceFeatureId: 'F128', proposalId: 'p-1' });

function fakeSessions(initial: ApprovalSession[] = []) {
  let list = initial;
  const listeners = new Set<() => void>();
  let version = 0;
  const fake = {
    open: vi.fn(),
    get: (key: string) => list.find((session) => session.key === key),
    list: () => list,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
    attemptsChanged: vi.fn(),
    hostReport: vi.fn(),
    readSettled: vi.fn(),
    reread: vi.fn(),
    authorize: vi.fn(() => true),
    close: vi.fn((key: string) => {
      list = list.filter((session) => session.key !== key);
      version += 1;
      for (const listener of listeners) listener();
    }),
  } satisfies ApprovalSessions;
  return fake;
}

const sessionIn = (state: ReconcileState, overrides: Partial<ApprovalSession> = {}): ApprovalSession => ({
  key: KEY,
  ownerUserId: OWNER,
  address: { sourceFeatureId: 'F128', proposalId: 'p-1' },
  decisionRef: row.decisionRef,
  approval: row.approval as never,
  model: { ...INITIAL_RECONCILE, seenAttemptId: 1, state },
  notice: null,
  ...overrides,
});

const decided: ReconcileState = {
  kind: 'decided',
  terminal: { resolution: 'accepted', decidedAt: 1_700_000_000_000, decidedBy: OWNER },
};

describe('the 待办 panel and the approvals it can host', () => {
  let host: HTMLDivElement;
  let root: Root;
  const $ = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const text = (testId: string) => $(testId)?.textContent ?? null;
  const show = (result: MailboxRead, staleRead: unknown = null) => {
    data.view.result = result;
    data.view.staleRead = staleRead;
  };
  const click = (testId: string) =>
    act(async () => {
      $(testId)?.click();
    });
  const openPanel = async () => {
    await act(async () => root.render(<MailboxButton />));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="mailbox-button"]')?.click();
    });
  };
  const expandFirst = () => click('mailbox-item-toggle');

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    data.hostedProps.length = 0;
    data.sessions = fakeSessions();
    data.view.resultGeneration = 1;
    show({ kind: 'loading' });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  describe('which rows host the original card', () => {
    it('an open, decidable approval hosts it in the expanded row, for the read’s verified owner', async () => {
      show(okRead([row]));
      await openPanel();
      await expandFirst();
      const stub = $('hosted-card-stub');
      expect(stub?.getAttribute('data-owner')).toBe(OWNER);
      expect(stub?.getAttribute('data-ref')).toBe(row.decisionRef);
      // The card brings its own way back; the row does not add a second primary one.
      expect($('mailbox-open-original')).toBeNull();
    });

    it('a collapsed row hosts nothing', async () => {
      show(okRead([row]));
      await openPanel();
      expect($('hosted-card-stub')).toBeNull();
    });

    it('an approval that is not decidable here keeps its single way to the original place', async () => {
      const settled = approvalRow(storeItem({ resolution: 'accepted' }));
      show(okRead([settled]));
      await openPanel();
      await expandFirst();
      expect($('hosted-card-stub')).toBeNull();
      expect($('mailbox-open-original')).not.toBeNull();
    });

    it('a producer whose decision belongs on its own origin card is never hosted', async () => {
      const origin = approvalRow(storeItem({ sourceFeatureId: 'F306', proposalId: 'p-origin' }));
      show(okRead([origin]));
      await openPanel();
      await expandFirst();
      expect($('hosted-card-stub')).toBeNull();
    });

    it('a row from the previous read has no body, so no card', async () => {
      const previous = okRead([row]);
      show({ kind: 'loading' }, previous.kind === 'ok' ? previous.read : null);
      await openPanel();
      expect($('hosted-card-stub')).toBeNull();
      expect($('mailbox-item')?.getAttribute('data-stale')).toBe('true');
    });

    it('a work row is untouched', async () => {
      const work: UnifiedAttentionItemV1 = {
        decisionRef: 'f306.runtime_interaction:r1:1',
        kind: 'judgment',
        summary: '受托工作 r1',
        linkedNeedsMe: [],
      };
      show(okRead([work]));
      await openPanel();
      await expandFirst();
      expect($('hosted-card-stub')).toBeNull();
      expect($('mailbox-open-original')).not.toBeNull();
    });
  });

  describe('a row says where its decision stands, even collapsed', () => {
    it('shows the line for a write in flight', async () => {
      data.sessions = fakeSessions([sessionIn({ kind: 'writing', attemptId: 2 })]);
      show(okRead([row]));
      await openPanel();
      expect(text('mailbox-row-session-line')).toBe('正在提交…');
    });

    it('shows an unknown as unknown, not as nothing', async () => {
      data.sessions = fakeSessions([sessionIn({ kind: 'unconfirmed', why: 'cannot_tell' })]);
      show(okRead([row]));
      await openPanel();
      expect(text('mailbox-row-session-line')).toBe('结果暂未确认');
    });

    it('offers the re-read on a closed row whose result can be read again, and asks the sessions to do it', async () => {
      const sessions = fakeSessions([sessionIn({ kind: 'unconfirmed', why: 'cannot_tell' })]);
      data.sessions = sessions;
      show(okRead([row]));
      await openPanel();
      await click('mailbox-row-reread');
      expect(sessions.reread).toHaveBeenCalledWith(KEY);
    });

    it('offers no re-read while the answer is still being confirmed, or when there is nothing to read again', async () => {
      for (const state of [
        { kind: 'writing', attemptId: 2 },
        { kind: 'confirming', attemptId: 2, write: { outcome: 'accepted', status: 200 }, afterGeneration: 1 },
        { kind: 'refused_before_send' },
      ] as ReconcileState[]) {
        data.sessions = fakeSessions([sessionIn(state)]);
        show(okRead([row]));
        await openPanel();
        expect($('mailbox-row-reread')).toBeNull();
        await click('mailbox-close');
      }
    });

    it('says nothing for a session that has not done anything', async () => {
      data.sessions = fakeSessions([sessionIn({ kind: 'idle' })]);
      show(okRead([row]));
      await openPanel();
      expect($('mailbox-row-session-line')).toBeNull();
    });

    it('does not repeat the line inside an open row, whose card already says it', async () => {
      data.sessions = fakeSessions([sessionIn({ kind: 'writing', attemptId: 2 })]);
      show(okRead([row]));
      await openPanel();
      await expandFirst();
      expect($('mailbox-row-session-line')).toBeNull();
    });

    it('does not show another owner’s session on this owner’s row', async () => {
      data.sessions = fakeSessions([
        sessionIn(
          { kind: 'writing', attemptId: 2 },
          { ownerUserId: 'owner-2', key: sessionKey('owner-2', { sourceFeatureId: 'F128', proposalId: 'p-1' }) },
        ),
      ]);
      show(okRead([row]));
      await openPanel();
      expect($('mailbox-row-session-line')).toBeNull();
    });
  });

  describe('a result outlives the row it belongs to', () => {
    it('keeps a decided result when the read no longer lists the approval', async () => {
      data.sessions = fakeSessions([sessionIn(decided)]);
      show(okRead([]));
      await openPanel();
      const retained = $('mailbox-retained-result');
      expect(retained).not.toBeNull();
      expect(retained?.textContent).toContain('已批准');
      // Named the way its row was named.
      expect(retained?.textContent).toContain('记一条品味');
    });

    it('lets the user dismiss it, and only then is it forgotten', async () => {
      const sessions = fakeSessions([sessionIn(decided)]);
      data.sessions = sessions;
      show(okRead([]));
      await openPanel();
      await click('mailbox-retained-dismiss');
      expect(sessions.close).toHaveBeenCalledWith(KEY);
      expect($('mailbox-retained-result')).toBeNull();
    });

    it('an unconfirmed result offers a re-read, which asks the sessions to read again', async () => {
      const sessions = fakeSessions([sessionIn({ kind: 'unconfirmed', why: 'left_the_list' })]);
      data.sessions = sessions;
      show(okRead([]));
      await openPanel();
      expect(text('mailbox-retained-line')).toBe('已不在当前待办，结果待确认');
      await click('mailbox-retained-reread');
      expect(sessions.reread).toHaveBeenCalledWith(KEY);
    });

    it('a result still being confirmed cannot be dismissed', async () => {
      data.sessions = fakeSessions([
        sessionIn({
          kind: 'confirming',
          attemptId: 2,
          write: { outcome: 'accepted', status: 200 },
          afterGeneration: 1,
        }),
      ]);
      show(okRead([]));
      await openPanel();
      expect(text('mailbox-retained-line')).toBe('已提交，正在确认结果…');
      expect($('mailbox-retained-dismiss')).toBeNull();
    });

    it('does not repeat it while the read still lists the approval', async () => {
      data.sessions = fakeSessions([sessionIn(decided)]);
      show(okRead([row]));
      await openPanel();
      expect($('mailbox-retained-result')).toBeNull();
    });

    it('never shows a session that has done nothing', async () => {
      data.sessions = fakeSessions([sessionIn({ kind: 'idle' })]);
      show(okRead([]));
      await openPanel();
      expect($('mailbox-retained-result')).toBeNull();
    });

    it('never shows another owner’s result', async () => {
      data.sessions = fakeSessions([
        sessionIn(decided, {
          ownerUserId: 'owner-2',
          key: sessionKey('owner-2', { sourceFeatureId: 'F128', proposalId: 'p-1' }),
        }),
      ]);
      show(okRead([]));
      await openPanel();
      expect($('mailbox-retained-result')).toBeNull();
    });

    it('shows none while the read is failed or unknown: the owner cannot be confirmed', async () => {
      data.sessions = fakeSessions([sessionIn(decided)]);
      for (const result of [{ kind: 'loading' }, { kind: 'failed', reason: 'unavailable' }] as MailboxRead[]) {
        show(result);
        await openPanel();
        expect($('mailbox-retained-result')).toBeNull();
        await click('mailbox-close');
      }
    });

    it('is not counted in the number: the rail and the tab say what the read proved', async () => {
      data.sessions = fakeSessions([sessionIn(decided)]);
      show(okRead([row], { totalCount: 4 }));
      await openPanel();
      expect(text('mailbox-tab-count')).toBe('4');
    });
  });

  describe('the sessions belong to the rail button', () => {
    it('hands the same sessions to the panel that the button created', async () => {
      const sessions = fakeSessions();
      data.sessions = sessions;
      show(okRead([row]));
      await openPanel();
      await expandFirst();
      const props = data.hostedProps.at(-1) as { sessions: unknown };
      expect(props.sessions).toBe(sessions);
    });
  });
});
