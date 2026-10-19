import type { UnifiedAttentionItemV1, UnifiedAttentionReadV1, UnifiedAttentionSourceRead } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailboxRead } from '../unified-mailbox-state';

const data = vi.hoisted(() => ({
  view: {
    result: { kind: 'loading' } as unknown,
    staleRead: null as unknown,
    badgeResult: undefined as MailboxRead | undefined,
    refetch: vi.fn(),
    nextPage: vi.fn(),
    previousPage: vi.fn(),
    setPersonalView: vi.fn(),
    setMentionPeriod: vi.fn(),
    readsStarted: () => 1,
    resultGeneration: 1 as number | null,
  },
  pathname: '/thread/current',
  push: vi.fn(),
  mode: vi.fn(),
  approvalRefresh: vi.fn(async () => undefined),
  navigate: vi.fn(),
}));
vi.mock('next/navigation', () => ({ usePathname: () => data.pathname, useRouter: () => ({ push: data.push }) }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (s: (v: { setWorkspaceMode: typeof data.mode }) => unknown) => s({ setWorkspaceMode: data.mode }),
}));
vi.mock('@/stores/approvalHubStore', () => {
  // The rail button follows approval decisions through the store (getState/subscribe); nothing is decided in this suite.
  const state = { fetchPending: data.approvalRefresh, items: [], decisionAttempts: {}, deciding: {}, error: null };
  const useApprovalHubStore = (s: (v: typeof state) => unknown) => s(state);
  useApprovalHubStore.getState = () => state;
  useApprovalHubStore.subscribe = () => () => undefined;
  return { useApprovalHubStore };
});
// How an exact place is opened (and from which page) is the helper's own concern, tested on its own; here the panel's part is
// that it hands the helper the action and the page it is on.
vi.mock('../mailbox/open-exact-place', () => ({ openExactPlace: data.navigate }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (catId: string) => `猫:${catId}` }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (catId: string) => ({
      displayName: `猫:${catId}`,
      nickname: `猫:${catId}`,
      avatar: '',
      color: { primary: 'var(--shell-ink)', secondary: 'var(--shell-paper)' },
    }),
  }),
}));
vi.mock('../use-unified-attention', () => ({ useUnifiedAttention: () => data.view }));

import { MailboxButton } from '../MailboxButton';

const source = (overrides: Partial<UnifiedAttentionSourceRead> = {}): UnifiedAttentionSourceRead => ({
  status: 'available',
  startedAt: 1,
  observedAt: 2,
  coverage: 'all_registered_F246_producers',
  exhaustiveness: 'complete',
  ...overrides,
});

// These panel-chrome cases exercise a generic row; native F128/family cards own their own headings.
const approvalItem = (id: string, summary = `审批 ${id}`): UnifiedAttentionItemV1 => ({
  decisionRef: `approval:F292:${id}`,
  kind: 'approval',
  summary,
  approval: {
    proposalId: id,
    sourceFeatureId: 'F292',
    resolution: 'open',
    materialization: { state: 'not_started' },
    requesterCatId: 'opus',
    summary,
    detail: {},
    navigation: { state: 'legacy_unanchored', legacySourceThreadId: null, legacySourceMessageId: null },
    createdAt: Date.now() - 2 * 3600_000,
  } as never,
  linkedNeedsMe: [],
});

const judgmentItem = (id: string, kind: 'judgment' | 'repair' = 'judgment'): UnifiedAttentionItemV1 => ({
  decisionRef: `f306.runtime_interaction:${id}:1`,
  kind,
  summary: `受托工作 ${id}`,
  linkedNeedsMe: [],
});

function read(overrides: Partial<UnifiedAttentionReadV1> = {}): UnifiedAttentionReadV1 {
  return {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: 'owner-1' },
    observedAt: 3,
    sources: {
      approvals: source(),
      needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
      structuredChoices: source({ coverage: 'pending_f306_structured_choices' }),
    },
    readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items: [],
    attentionCount: overrides.totalCount,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
    ...overrides,
  };
}
const ok = (overrides: Partial<UnifiedAttentionReadV1> = {}): MailboxRead => ({ kind: 'ok', read: read(overrides) });

describe('F322 待办 (the mailbox) on the unified read', () => {
  let host: HTMLDivElement;
  let root: Root;
  const button = () => {
    const found = host.querySelector<HTMLButtonElement>('[data-testid="mailbox-button"]');
    if (!found) throw new Error('Mailbox rail button is missing');
    return found;
  };
  const panel = () => document.querySelector<HTMLElement>('[data-testid="mailbox-panel"]');
  const text = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="mailbox-item"]')];
  const render = () => act(() => root.render(<MailboxButton />));
  const open = () => act(() => button().click());
  const show = (result: MailboxRead, staleRead: UnifiedAttentionReadV1 | null = null) => {
    data.view.result = result;
    data.view.staleRead = staleRead;
  };

  beforeEach(() => {
    data.view.badgeResult = undefined;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    vi.clearAllMocks();
    data.pathname = '/thread/current';
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

  it('separates waiting decisions from mentions without hiding other existing work', () => {
    show(
      ok({
        items: [
          approvalItem('group-approval'),
          judgmentItem('repair', 'repair'),
          {
            decisionRef: 'mention:group',
            kind: 'user_mention',
            summary: '@you',
            linkedNeedsMe: [],
            userMention: {
              threadId: 'thread_group',
              messageId: 'message-group',
              catId: 'codex61-sol',
              content: 'Please look here',
              timestamp: 2,
              expectedRevision: 0,
            },
          },
        ],
        totalCount: 3,
        attentionCount: 1,
      }),
    );
    render();
    open();
    const decisions = document.querySelector('[data-testid="mailbox-group-decisions"]');
    const mentions = document.querySelector('[data-testid="mailbox-group-mentions"]');
    expect(decisions?.textContent).toContain('等你决定');
    expect(mentions?.textContent).toContain('@你');
    expect(decisions?.querySelectorAll('[data-testid="mailbox-item"]').length).toBe(1);
    expect(document.querySelector('[data-testid="mailbox-group-other"]')?.textContent).toContain('需要修复');
    expect(mentions?.querySelectorAll('[data-testid="mailbox-item"]').length).toBe(1);
  });

  it('puts each proven empty state inside its own group', () => {
    show(ok({ items: [], totalCount: 0, attentionCount: 0 }));
    render();
    open();
    expect(document.querySelector('[data-testid="mailbox-group-decisions"]')?.textContent).toContain(
      '暂无等你决定的事',
    );
    expect(document.querySelector('[data-testid="mailbox-group-mentions"]')?.textContent).toContain('暂无 @你 请求');
  });

  it('keeps a recovery entrance even when no current item is ignored', () => {
    show(ok({ items: [], totalCount: 0, attentionCount: 0 }));
    render();
    open();
    const ignored = document.querySelector<HTMLButtonElement>('[data-testid="mailbox-open-ignored"]');
    expect(ignored).not.toBeNull();
    act(() => ignored?.click());
    expect(data.view.setPersonalView).toHaveBeenCalledWith('ignored', 'week');
    expect(text('mailbox-title')).toBe('已忽略');
  });

  it('opens Schedule from the second mailbox tab through the original Workspace destination and closes the panel', () => {
    show(ok({ totalCount: 0 }));
    render();
    open();
    const schedule = document.querySelector<HTMLButtonElement>('[data-testid="mailbox-tab-schedule"]');
    expect(schedule).not.toBeNull();
    expect(schedule?.textContent).toBe('日程');
    expect(schedule?.querySelector('[data-testid*="count"]')).toBeNull();
    act(() => schedule?.click());
    expect(data.mode).toHaveBeenCalledWith('product-schedule');
    expect(data.push).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
    expect(data.navigate).not.toHaveBeenCalled();
  });

  it('keeps a mention in the panel while the decision-only badge is zero', () => {
    show(
      ok({
        items: [{ decisionRef: 'mention:one', kind: 'user_mention', summary: '@你请求', linkedNeedsMe: [] }],
        totalCount: 1,
        attentionCount: 0,
      }),
    );
    render();
    expect(host.querySelector('[data-testid="rail-badge-count"]')).toBeNull();
    open();
    expect(text('mailbox-tab-count')).toBe('0');
    expect(rows()).toHaveLength(1);
    expect(text('mailbox-state-text')).toContain('1 件');
  });

  describe('what the rail entry claims', () => {
    const badgeOf = () => host.querySelector('[data-testid^="rail-badge-"]');
    const cases: [string, MailboxRead, string, string | null, string?][] = [
      ['first read in flight', { kind: 'loading' }, '读取中', 'loading'],
      [
        'proven total of 3',
        ok({ items: [approvalItem('a'), approvalItem('b')], totalCount: 3 }),
        '3 件',
        'count',
        '当前范围共 3 件',
      ],
      [
        'rows but no total',
        ok({ items: [approvalItem('a')], consistency: { state: 'uncertain', reasons: ['x'] } }),
        '数量未确认',
        'dot',
      ],
      ['proven empty', ok({ items: [], totalCount: 0 }), '暂无', null],
      [
        'one side unread and an unqualified judgment row: "!", with no decision count claim',
        ok({
          status: 'partial',
          items: [judgmentItem('j')],
          sources: { approvals: source({ status: 'unavailable', exhaustiveness: 'unknown' }), needsMe: source() },
        }),
        '仅部分读取',
        'alert',
        '仅部分读取 · 已确认有事',
      ],
      [
        'one side unread, nothing from the other',
        ok({
          status: 'partial',
          items: [],
          sources: { approvals: source({ status: 'unavailable', exhaustiveness: 'unknown' }), needsMe: source() },
        }),
        '仅部分读取',
        'alert',
      ],
      [
        'every source down',
        ok({
          status: 'unavailable',
          sources: {
            approvals: source({ status: 'invalid', exhaustiveness: 'unknown' }),
            needsMe: source({ status: 'unavailable', exhaustiveness: 'unknown' }),
          },
        }),
        '暂不可用',
        'alert',
      ],
      ['route failure', { kind: 'failed', reason: 'unavailable' }, '暂不可用', 'alert'],
      ['explicit 401', { kind: 'failed', reason: 'unauthenticated' }, '需要登录', null],
    ];
    it.each(cases)('%s → %s', (_name, result, state, badge, panelState = state) => {
      show(result);
      render();
      expect(button().getAttribute('aria-label')).toBe(`待办，${state}`);
      expect(button().getAttribute('title')).toBeNull();
      expect(badgeOf()?.getAttribute('data-testid') ?? null).toBe(badge ? `rail-badge-${badge}` : null);
      open();
      if (panelState === '暂无')
        expect(document.querySelector('[data-testid="mailbox-group-decisions"]')?.textContent).toContain(
          '暂无等你决定的事',
        );
      else expect(text('mailbox-state-text')).toBe(panelState);
      expect(text('mailbox-title')).toBe('待办');
      expect(document.querySelector('[data-testid="mailbox-panel"] [title]')).toBeNull();
    });

    it('prints the proven total, not the number of rows it happens to hold', () => {
      show(ok({ items: [approvalItem('a'), approvalItem('b')], totalCount: 25 }));
      render();
      expect(host.querySelector('[data-testid="rail-badge-count"]')?.textContent).toBe('25');
    });

    it('dims the icon only when the whole read needs a login — otherwise a login-less user would see an empty box', () => {
      show({ kind: 'failed', reason: 'unauthenticated' });
      render();
      expect(button().getAttribute('data-dimmed')).toBe('true');
      expect(badgeOf()).toBeNull();
      // still reachable: dimmed is a look, not a disabled control
      expect(button().disabled).toBe(false);
      for (const other of [
        ok({ items: [], totalCount: 0 }),
        { kind: 'failed', reason: 'unavailable' } as MailboxRead,
        { kind: 'loading' } as MailboxRead,
      ]) {
        show(other);
        render();
        expect(button().getAttribute('data-dimmed')).toBeNull();
      }
    });

    it('retains confirmed rail and panel counts during background loading without authorizing stale actions', () => {
      data.view.badgeResult = ok({ totalCount: 3 });
      show({ kind: 'loading' });
      render();
      expect(host.querySelector('[data-testid="rail-badge-count"]')?.textContent).toBe('3');
      open();
      expect(panel()?.querySelector('[data-testid="mailbox-tab-count"]')?.textContent).toBe('3');
    });

    it('never prints a digit while the count is unconfirmed, loading or failed', () => {
      for (const result of [
        { kind: 'loading' } as MailboxRead,
        ok({ items: [approvalItem('a')], consistency: { state: 'uncertain', reasons: ['x'] } }),
        { kind: 'failed', reason: 'unavailable' } as MailboxRead,
      ]) {
        show(result);
        render();
        expect(button().getAttribute('aria-label')).not.toMatch(/\d/);
        expect(host.querySelector('[data-testid="rail-badge-count"]')).toBeNull();
      }
    });
  });

  describe('panel', () => {
    it('covers the mobile viewport instead of docking behind an expanded navigation drawer', () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
      show(ok({ items: [], totalCount: 0 }));
      render();
      open();
      expect(panel()?.style.left).toBe('0px');
      expect(panel()?.style.visibility).toBe('visible');
    });

    it('focus enters the first row; Escape closes the panel and returns to the rail button', () => {
      show(ok({ items: [approvalItem('a')], totalCount: 1 }));
      render();
      open();
      expect(button().getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(rows()[0].querySelector('button'));
      act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(button());
    });

    it('with no row to focus, focus still lands inside the panel', () => {
      show(ok({ items: [], totalCount: 0 }));
      render();
      open();
      expect(panel()?.contains(document.activeElement)).toBe(true);
    });

    it('stays open when the pointer goes down elsewhere: a card’s own dialog is not "outside"', () => {
      render();
      open();
      const elsewhere = document.createElement('button');
      document.body.append(elsewhere);
      act(() => {
        elsewhere.focus();
        elsewhere.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });
      expect(panel()).not.toBeNull();
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });

    it('closes from the × and gives focus back to the rail button', () => {
      render();
      open();
      act(() => document.querySelector<HTMLButtonElement>('[data-testid="mailbox-close"]')?.click());
      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(button());
    });

    it('lets a nested dialog own Escape while it is open, and closes on the next one', () => {
      render();
      open();
      const nested = document.createElement('div');
      nested.setAttribute('role', 'dialog');
      document.body.append(nested);
      const pressEscape = () => act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      pressEscape();
      expect(panel()).not.toBeNull();
      nested.remove();
      pressEscape();
      expect(panel()).toBeNull();
    });

    it('is one full-height panel with a plain 需要我处理 heading and only the proven count', () => {
      show(ok({ items: [approvalItem('a')], totalCount: 7 }));
      render();
      open();
      expect(panel()?.className).toMatch(/\btop-0\b/);
      expect(panel()?.className).toMatch(/\bbottom-0\b/);
      expect(panel()?.getAttribute('aria-label')).toBe('待办');
      expect(document.querySelector('[role="tab"]')).toBeNull();
      const heading = document.querySelector('[data-testid="mailbox-tab-needs-me"]');
      expect(heading?.textContent).toBe('需要我处理7');
      expect(document.querySelector('[role="region"]')?.getAttribute('aria-labelledby')).toBe(heading?.id);
    });

    it('prints no number beside the tab when the total is unconfirmed, partial, loading or failed', () => {
      for (const result of [
        { kind: 'loading' } as MailboxRead,
        ok({ items: [approvalItem('a')], consistency: { state: 'uncertain', reasons: ['x'] } }),
        ok({
          status: 'partial',
          items: [approvalItem('a')],
          totalCount: 1,
          sources: { approvals: source(), needsMe: source({ status: 'unavailable', exhaustiveness: 'unknown' }) },
        }),
        { kind: 'failed', reason: 'unavailable' } as MailboxRead,
      ]) {
        show(result);
        render();
        open();
        expect(document.querySelector('[data-testid="mailbox-tab-count"]')).toBeNull();
        act(() => document.querySelector<HTMLButtonElement>('[data-testid="mailbox-close"]')?.click());
      }
    });

    describe('how it looks against the 1.6 board', () => {
      const workRow = (extra: { ownerCatId?: string; title?: string }) => {
        const item = judgmentItem('j');
        item.linkedNeedsMe = [
          {
            ownerRead: {
              envelope: { subjectRef: 't', revision: 1, visibility: { ownerUserId: 'owner-1' } },
              work: { title: extra.title, ownerCatId: extra.ownerCatId },
            },
            receipt: { eligible: true, kind: 'judgment', producer: { producerId: 'p', subjectRef: 's', revision: 1 } },
          } as never,
        ];
        return item;
      };
      const avatars = (index: number) => rows()[index].querySelectorAll('[data-testid="mailbox-item-avatar"]');

      it('puts the panel on the work colour and every row on paper with a hairline, open or closed', () => {
        show(ok({ items: [approvalItem('a'), judgmentItem('j')], totalCount: 2 }));
        render();
        open();
        expect(panel()?.style.background).toContain('--shell-work');
        const toggle = rows()[0].querySelector<HTMLButtonElement>('[data-testid="mailbox-item-toggle"]');
        for (const row of rows()) {
          expect(row.style.background).toContain('--shell-paper');
          expect(row.style.border).toContain('--shell-hairline)');
        }
        act(() => toggle?.click());
        expect(rows()[0].style.background).toContain('--shell-paper');
        expect(rows()[0].style.border).toContain('--shell-hairline-strong');
        expect(rows()[1].style.border).not.toContain('--shell-hairline-strong');
      });

      it('shows two destination buttons and keeps the proven count on Needs me alone', () => {
        show(ok({ totalCount: 7 }));
        render();
        open();
        expect(document.querySelector('[role="tablist"]')).toBeNull();
        expect(document.querySelector('[data-testid="mailbox-tab-needs-me"]')?.tagName).toBe('BUTTON');
        expect(document.querySelector('[data-testid="mailbox-tab-schedule"]')?.textContent).toBe('日程');
        const pill = document.querySelector<HTMLElement>('[data-testid="mailbox-tab-count"]');
        expect(pill?.style.background).toBe('var(--shell-paper)');
        expect(pill?.style.color).toBe('var(--shell-ink)');
      });

      it('an approval row leads with the proposing cat’s avatar and bold name, then the title, then the feature', () => {
        show(ok({ items: [approvalItem('a', '记一条品味')], totalCount: 1 }));
        render();
        open();
        expect(avatars(0)).toHaveLength(1);
        const bold = rows()[0].querySelector('.font-semibold');
        expect(bold?.textContent?.trim()).toBe('猫:opus');
        expect(rows()[0].textContent).toContain('记一条品味');
        expect(rows()[0].textContent).not.toMatch(/由 .* 发起/);
      });

      it('keeps the original family heading without a second generic approval toggle', () => {
        // F225 (session handoff): the summary is "Session handoff: <catId> → …" and the title cleaner turns the id into the name.
        const handoff = approvalItem('h', 'Session handoff: opus → codex: 交接说明');
        (handoff.approval as { sourceFeatureId: string; requesterCatId: string }).sourceFeatureId = 'F225';
        // F193 (work assignment): "派给 <target>：…" does not lead with the proposer, so the proposer is the bold lead-in.
        const assignment = approvalItem('w', 'Work assignment: 写文档');
        const assigned = assignment.approval as { sourceFeatureId: string; detail: Record<string, unknown> };
        assigned.sourceFeatureId = 'F193';
        assigned.detail = { content: '写文档', targetCats: ['codex'] };
        show(ok({ items: [handoff, assignment], totalCount: 2 }));
        render();
        open();
        const header = (index: number) => rows()[index].querySelector('[data-testid="mailbox-item-toggle"]');
        const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
        const handoffText = header(0)?.textContent ?? '';
        expect(occurrences(handoffText, '猫:opus')).toBe(1);
        expect(handoffText).toContain('猫:opus → codex: 交接说明');
        expect(rows()[0].querySelector('.font-semibold')?.textContent?.trim()).toBe('猫:opus');
        // F193 now renders the same original family card as Chat. Its own heading replaces the legacy row toggle.
        expect(header(1)).toBeNull();
        expect(occurrences(rows()[1].textContent ?? '', '猫:opus')).toBe(1);
        expect(rows()[1].querySelector('[data-testid="approval-item-w"]')?.textContent).toContain('写文档');
        const reject = rows()[1].querySelector<HTMLButtonElement>('[data-testid="reject-btn"]');
        expect(reject).not.toBeNull();
        expect(reject?.disabled).toBe(true); // no original publication proof in this panel-only fixture
      });

      it('a work row shows the owning cat’s avatar and "<cat> 的受托工作「…」" only from what the contract names', () => {
        show(
          ok({
            items: [
              workRow({ ownerCatId: 'gemini', title: '会议封面' }),
              workRow({ title: '会议封面' }),
              workRow({ ownerCatId: 'gemini' }),
              judgmentItem('plain'),
            ],
            totalCount: 4,
          }),
        );
        render();
        open();
        const lines = rows().map((row) => row.querySelector('.truncate')?.textContent ?? null);
        expect(lines).toEqual([
          '猫:gemini 的受托工作「会议封面」',
          '受托工作「会议封面」',
          '猫:gemini 的受托工作',
          null,
        ]);
        expect(rows().map((_row, index) => avatars(index).length)).toEqual([1, 0, 1, 0]);
        expect(rows()[0].querySelector('.font-semibold')).toBeNull();
      });

      it.each([
        ['forbidden', '无权查看'],
        ['invalid', '无法读取'],
        ['unavailable', '暂不可用'],
      ] as const)('names a %s source in its own words, and leaves the overall state alone', (status, words) => {
        show(
          ok({
            status: 'partial',
            items: [judgmentItem('j')],
            sources: { approvals: source({ status, exhaustiveness: 'unknown' }), needsMe: source() },
          }),
        );
        render();
        open();
        expect(text('mailbox-source-note-approvals')).toBe(`审批：${words}`);
        expect(text('mailbox-state-text')).toBe('仅部分读取 · 已确认有事');
      });
    });

    it('lists each confirmed item with its kind and what it is about', () => {
      show(
        ok({ items: [approvalItem('a', '记一条品味'), judgmentItem('j'), judgmentItem('r', 'repair')], totalCount: 3 }),
      );
      render();
      open();
      const labels = rows().map((row) => row.getAttribute('data-kind-label'));
      expect(labels).toEqual(['审批', '等你判断', '需要修复']);
      expect(rows()[0].textContent).toContain('记一条品味');
      expect(rows()[0].textContent).toContain('猫:opus');
      expect(rows()[1].textContent).toContain('受托工作 j');
    });

    it('does not crash on an approval source this build does not know; it shows the raw id', () => {
      const unknown = approvalItem('u');
      (unknown.approval as { sourceFeatureId: string }).sourceFeatureId = 'F999';
      show(ok({ items: [unknown], totalCount: 1 }));
      render();
      open();
      expect(rows()[0].textContent).toContain('F999');
    });

    it('shows an approval once while keeping each work variant for its own decision', () => {
      const twin = { ...approvalItem('a'), summary: '同一个决定的另一个版本' };
      show(
        ok({ items: [approvalItem('a'), twin, judgmentItem('same-task'), judgmentItem('same-task')], totalCount: 4 }),
      );
      render();
      open();
      expect(rows()).toHaveLength(3);
      expect(new Set(rows().map((row) => row.getAttribute('data-row-key'))).size).toBe(3);
    });

    describe('opening a row', () => {
      const toggle = (index: number) =>
        rows()[index].querySelector<HTMLButtonElement>('[data-testid="mailbox-item-toggle"]');
      const body = (index: number) => rows()[index].querySelector('[data-testid="mailbox-item-body"]');
      const openOriginal = () => document.querySelectorAll<HTMLButtonElement>('[data-testid="mailbox-open-original"]');

      it('starts collapsed, expands on click and collapses on the next click', () => {
        show(ok({ items: [judgmentItem('j')], totalCount: 1 }));
        render();
        open();
        expect(body(0)).toBeNull();
        expect(toggle(0)?.getAttribute('aria-expanded')).toBe('false');
        act(() => toggle(0)?.click());
        expect(body(0)).not.toBeNull();
        expect(toggle(0)?.getAttribute('aria-expanded')).toBe('true');
        expect(toggle(0)?.getAttribute('aria-controls')).toBe(body(0)?.id);
        act(() => toggle(0)?.click());
        expect(body(0)).toBeNull();
      });

      it('keeps one row open at a time, and so only one primary button on screen', () => {
        show(ok({ items: [judgmentItem('a'), judgmentItem('j'), judgmentItem('r', 'repair')], totalCount: 3 }));
        render();
        open();
        act(() => toggle(0)?.click());
        expect(openOriginal()).toHaveLength(1);
        act(() => toggle(2)?.click());
        expect(body(0)).toBeNull();
        expect(body(2)).not.toBeNull();
        expect(openOriginal()).toHaveLength(1);
      });

      it('a row that left the read does not pop open again when a later read brings it back', () => {
        show(ok({ items: [judgmentItem('j'), judgmentItem('k')], totalCount: 2 }));
        render();
        open();
        act(() => toggle(1)?.click());
        expect(openOriginal()).toHaveLength(1);
        show(ok({ items: [judgmentItem('j')], totalCount: 1 }));
        render();
        expect(openOriginal()).toHaveLength(0);
        show(ok({ items: [judgmentItem('j'), judgmentItem('k')], totalCount: 2 }));
        render();
        expect(rows()).toHaveLength(2);
        expect(openOriginal()).toHaveLength(0);
      });

      it('says what the contract carries about a 等你判断 row, and nothing it does not', () => {
        const item = judgmentItem('j');
        item.linkedNeedsMe = [
          {
            ownerRead: {
              envelope: { subjectRef: 't', revision: 1, visibility: { ownerUserId: 'owner-1' } },
              brief: { outcome: { state: 'known', value: '下周会议封面' } },
              work: { title: '会议封面' },
              preparedArtifact: {
                artifactRef: 'a',
                artifactRevision: '1',
                completenessRef: 'c',
                previewRef: 'p',
                openInWorkspaceRef: 'w',
              },
            },
            receipt: {
              eligible: true,
              kind: 'judgment',
              recommendation: '用 v3',
              producer: { producerId: 'p', subjectRef: 's', revision: 1 },
            },
          } as never,
        ];
        show(ok({ items: [item], totalCount: 1 }));
        render();
        open();
        act(() => toggle(0)?.click());
        expect(text('mailbox-detail-recommendation')).toBe('建议 用 v3');
        expect(text('mailbox-detail-goal')).toBe('目标 下周会议封面');
        expect(text('mailbox-detail-prepared')).toBe('成果 准备好的作品');
        // The row names the entrusted work it belongs to, and does not pass it off as a source feature.
        expect(rows()[0].textContent).toContain('受托工作「会议封面」');
        expect(rows()[0].textContent).not.toMatch(/来源|由 .* 发起/);
        // The contract has no "what choosing it will cause": that line is not drawn, and no placeholder stands in for it.
        expect(body(0)?.textContent).not.toMatch(/影响|unknown|未知/);
      });

      it('draws no detail line the contract did not give, instead of an empty or placeholder one', () => {
        show(ok({ items: [judgmentItem('j')], totalCount: 1 }));
        render();
        open();
        act(() => toggle(0)?.click());
        expect(body(0)?.querySelectorAll('[data-testid^="mailbox-detail-"]')).toHaveLength(0);
        expect(openOriginal()).toHaveLength(1);
      });

      it('omits the link and placeholder when an approval has no reliable original place', () => {
        show(ok({ items: [approvalItem('a')], totalCount: 1 }));
        render();
        open();
        act(() => toggle(0)?.click());
        expect(text('mailbox-place-note')).toBeNull();
        expect(openOriginal()).toHaveLength(0);
        expect(text('mailbox-history')).toBe('已处理的 @你');
        expect(text('mailbox-records')).toBe('审批记录');
      });

      it.each([
        ['judgment', judgmentItem('j'), 'needs-me', 0, '打开待处理列表'],
        ['repair', judgmentItem('r', 'repair'), 'needs-me', 0, '打开待处理列表'],
      ] as const)('a %s row whose place cannot be located opens its list, named as the list', (_kind, item, mode, approvalRefreshes, label) => {
        show(ok({ items: [item], totalCount: 1 }));
        render();
        open();
        expect(data.mode).not.toHaveBeenCalled();
        act(() => toggle(0)?.click());
        // Expanding a row is reading, never acting.
        expect(data.mode).not.toHaveBeenCalled();
        expect(data.approvalRefresh).not.toHaveBeenCalled();
        expect(openOriginal()[0].textContent).toBe(label);
        act(() => openOriginal()[0].click());
        expect(data.mode).toHaveBeenCalledWith(mode);
        expect(data.approvalRefresh).toHaveBeenCalledTimes(approvalRefreshes);
        expect(data.navigate).not.toHaveBeenCalled();
        expect(data.push).not.toHaveBeenCalled();
        expect(panel()).toBeNull();
      });

      it('a work row whose action is a source message goes to that message and says "打开原处处理"', () => {
        const item = judgmentItem('j');
        item.linkedNeedsMe = [
          {
            ownerRead: { envelope: { subjectRef: 't', revision: 1, visibility: { ownerUserId: 'owner-1' } } },
            receipt: {
              eligible: true,
              kind: 'judgment',
              action: { actionRef: 'message:thread-1:msg-1#block-1', expectedProducerRevision: 1 },
              producer: { producerId: 'f306.runtime_interaction', subjectRef: 's', revision: 1 },
            },
          } as never,
        ];
        show(ok({ items: [item], totalCount: 1 }));
        render();
        open();
        act(() => toggle(0)?.click());
        expect(document.querySelector('[data-testid="mailbox-place-note"]')).toBeNull();
        expect(openOriginal()[0].textContent).toBe('打开原处处理');
        act(() => openOriginal()[0].click());
        expect(data.navigate).toHaveBeenCalledWith('message:thread-1:msg-1#block-1', '/thread/current');
        // An exact place is not a workspace panel: the workspace mode is left alone.
        expect(data.mode).not.toHaveBeenCalled();
        expect(panel()).toBeNull();
      });

      it('rows from a previous read cannot be opened and carry no action while the new read is in flight', () => {
        show(ok({ items: [judgmentItem('j')], totalCount: 1 }));
        render();
        open();
        act(() => toggle(0)?.click());
        expect(openOriginal()).toHaveLength(1);
        show({ kind: 'loading' }, read({ items: [judgmentItem('j')], totalCount: 1 }));
        render();
        expect(rows()).toHaveLength(1);
        expect(rows()[0].getAttribute('data-stale')).toBe('true');
        expect(toggle(0)?.disabled).toBe(true);
        expect(openOriginal()).toHaveLength(0);
        // A click on it does nothing even if something forced one through.
        act(() => toggle(0)?.click());
        expect(openOriginal()).toHaveLength(0);
        expect(data.mode).not.toHaveBeenCalled();
      });
    });

    it('names only the source that could not be read, and lists what the other one returned', () => {
      show(
        ok({
          status: 'partial',
          items: [judgmentItem('j')],
          sources: {
            approvals: source({ status: 'unauthenticated', exhaustiveness: 'unknown' }),
            needsMe: source({ coverage: 'current_linked_F310_five_producers' }),
          },
        }),
      );
      render();
      open();
      expect(text('mailbox-source-note-approvals')).toBe('审批：需要登录');
      expect(document.querySelector('[data-testid="mailbox-source-note-needs-me"]')).toBeNull();
      expect(rows()).toHaveLength(1);
    });

    it('explains an empty result that could not be confirmed, instead of leaving "partial" unexplained', () => {
      show(ok({ items: [], consistency: { state: 'uncertain', reasons: ['x'] } }));
      render();
      open();
      expect(text('mailbox-state-text')).toBe('仅部分读取');
      expect(text('mailbox-partial-note')).toBe('这次没能确认各项读取对得上');
      expect(document.querySelector('[data-testid="mailbox-empty"]')).toBeNull();
    });

    it('has no extra explanation when a source simply was not read — that source names itself', () => {
      show(
        ok({
          status: 'partial',
          items: [],
          sources: { approvals: source({ status: 'unavailable', exhaustiveness: 'unknown' }), needsMe: source() },
        }),
      );
      render();
      open();
      expect(document.querySelector('[data-testid="mailbox-partial-note"]')).toBeNull();
      expect(text('mailbox-source-note-approvals')).toBe('审批：暂不可用');
    });

    it('offers a retry that re-reads when the read failed or only partly succeeded', () => {
      show({ kind: 'failed', reason: 'unavailable' });
      render();
      open();
      expect(rows()).toHaveLength(0);
      act(() => document.querySelector<HTMLButtonElement>('[data-testid="mailbox-retry"]')?.click());
      expect(data.view.refetch).toHaveBeenCalledTimes(1);
    });

    it('does not offer a retry for a proven empty read, and says it plainly', () => {
      show(ok({ items: [], totalCount: 0 }));
      render();
      open();
      expect(document.querySelector('[data-testid="mailbox-group-decisions"]')?.textContent).toContain(
        '暂无等你决定的事',
      );
      expect(document.querySelector('[data-testid="mailbox-group-mentions"]')?.textContent).toContain('暂无 @你 请求');
      expect(document.querySelector('[data-testid="mailbox-retry"]')).toBeNull();
    });

    it('keeps the previous rows visible while re-reading, labelled as the previous read and never counted', () => {
      show({ kind: 'loading' }, read({ items: [approvalItem('a')], totalCount: 1 }));
      render();
      expect(button().getAttribute('aria-label')).toBe('待办，读取中');
      expect(host.querySelector('[data-testid="rail-badge-count"]')).toBeNull();
      open();
      expect(text('mailbox-stale-note')).toBe('上次读到的内容，正在更新');
      expect(rows()).toHaveLength(1);
      expect(rows()[0].getAttribute('data-stale')).toBe('true');
    });

    it('shows no rows and no stale note when loading for the first time', () => {
      render();
      open();
      expect(rows()).toHaveLength(0);
      expect(document.querySelector('[data-testid="mailbox-stale-note"]')).toBeNull();
    });

    it('describes the current page and exposes real navigation when more rows exist', () => {
      show(
        ok({
          items: [approvalItem('a')],
          totalCount: 40,
          page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: true },
        }),
      );
      render();
      open();
      expect(text('mailbox-has-more')).toBe('还有更多事项，本页显示 1 件');
      act(() => document.querySelector<HTMLButtonElement>('[data-testid="mailbox-next-page"]')?.click());
      expect(data.view.nextPage).toHaveBeenCalledOnce();
      expect(document.querySelector<HTMLButtonElement>('[data-testid="mailbox-previous-page"]')?.disabled).toBe(true);
    });

    it('stays quiet about paging when the page reports no more rows', () => {
      show(ok({ items: [approvalItem('a')], totalCount: 1 }));
      render();
      open();
      expect(document.querySelector('[data-testid="mailbox-has-more"]')).toBeNull();
    });
  });
});
