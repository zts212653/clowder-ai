import type { IgnoredItemSnapshot, UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { binding, block, cardRef, request } from '../../../rich/__tests__/runtime-conversation-test-fixtures';
import { MailboxPanel } from '../../MailboxPanel';
import { parseUnifiedAttentionRead } from '../../parse-unified-attention';
import { writeShellLanguage } from '../../shell-language';
import { deriveMailboxPanelState } from '../../unified-mailbox-state';
import type { UnifiedAttentionView } from '../../use-unified-attention';
import { useApprovalSessions } from '../use-approval-sessions';
import { collectiveResultRow, OWNER, okRead, storeItem } from './mailbox-fixtures';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));
const coordinate = {
  kind: 'mailbox' as const,
  decisionRef: 'mention:source',
  version: 'sha256:exact-producer-version',
};
const item: UnifiedAttentionItemV1 = {
  decisionRef: coordinate.decisionRef,
  kind: 'user_mention',
  summary: 'A real mention',
  linkedNeedsMe: [],
  preferenceCoordinate: coordinate,
  userMention: {
    threadId: 'thread_source',
    messageId: 'message-source',
    catId: 'codex61-sol',
    timestamp: 10,
    content: 'Please look here',
    expectedRevision: 2,
  },
};
const source = {
  status: 'available' as const,
  startedAt: 1,
  observedAt: 2,
  coverage: 'owner_personal_ignored_items' as const,
  exhaustiveness: 'complete' as const,
};
let mode: 'visible' | 'ignored';
let history: boolean;
let view: UnifiedAttentionView;
let revision: number;
let preferenceEntries: IgnoredItemSnapshot['entries'];
let owner: string;
let refuse: boolean;
let unavailableSave: boolean;
let previewReads: number;
let changePreview: boolean;
let previewPartial: boolean;
let root: Root;
let host: HTMLDivElement;
const writes = () => mocks.apiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH');
function Wrapper() {
  const sessions = useApprovalSessions(view);
  return (
    <MailboxPanel
      anchor={createRef()}
      view={view}
      sessions={sessions}
      state={deriveMailboxPanelState(view.result)}
      section={history ? 'history' : mode === 'ignored' ? 'ignored' : 'pending'}
      onOpenPlace={vi.fn()}
      onClose={vi.fn()}
      onSectionChange={vi.fn()}
    />
  );
}
const render = async () => act(async () => root.render(<Wrapper />));
const click = async (id: string) => {
  if (
    !document.querySelector(`[data-testid="${id}"]`) &&
    (id === 'mailbox-item-toggle' || id === 'mailbox-item-restore')
  ) {
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="mailbox-history-item-toggle"]')?.click(),
    );
    if (id === 'mailbox-item-toggle') return;
  }
  if (id !== 'mailbox-item-toggle' || document.querySelector('[data-testid="mailbox-item-toggle"]'))
    await act(async () => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)?.click());
};
function read() {
  if (mode === 'ignored' && revision === 4) preferenceEntries = [{ coordinate, ignoredAt: 20 }];
  const result = okRead([item]);
  if (result.kind !== 'ok') throw new Error('Fixture');
  result.read.sources.personalPreferences = source;
  result.read.sources.userMentions = { ...source, coverage: 'explicit_user_mentions' };
  result.read.sources.structuredChoices = { ...source, coverage: 'pending_f306_structured_choices' };
  result.read.personalView = {
    mode,
    preferenceRevision: revision,
    originalTotalCount: 1,
    visibleTotalCount: mode === 'visible' ? 1 : 0,
    ignoredTotalCount: mode === 'ignored' ? 1 : 0,
    originalAttentionCount: 0,
    visibleAttentionCount: 0,
    ignoredAttentionCount: 0,
  };
  result.read.attentionCount = 0;
  result.read.identity.ownerUserId = owner;
  view = { result, staleRead: null, refetch: vi.fn(), readsStarted: () => 1, resultGeneration: 1 };
}
function refetchThroughUnconfirmedOwner() {
  view.refetch = vi.fn(() => {
    view = { ...view, result: { kind: 'loading' }, staleRead: null, resultGeneration: null, readsStarted: () => 2 };
    root.render(<Wrapper />);
  });
}
async function settleSameOwnerRead() {
  read();
  view = { ...view, resultGeneration: 2, readsStarted: () => 2 };
  await render();
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mode = 'visible';
  history = false;
  localStorage.clear();
  revision = 4;
  preferenceEntries = [];
  owner = OWNER;
  refuse = false;
  unavailableSave = false;
  previewReads = 0;
  changePreview = false;
  previewPartial = false;
  read();
  mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/session') return Response.json({ userId: owner });
    if (path === '/api/concierge/work/mentions/last-handling')
      return Response.json({ ownerUserId: owner, receipt: { undoId: 'canonical-last', handled: 1, remaining: 1 } });
    if (path === '/api/concierge/work/mentions/restore') return Response.json({ restored: true });
    if (path.startsWith('/api/concierge/work/mentions/handling-preview')) {
      previewReads++;
      const scope = new URL(path, 'http://localhost').searchParams.get('period');
      const requests = Array.from({ length: 26 }, (_, index) => ({
        threadId: `thread_${index}`,
        messageId: `message-${index}`,
        expectedRevision: 2,
        preferenceCoordinate: {
          kind: 'mailbox',
          decisionRef: `mention:${index}`,
          version: changePreview && previewReads > 1 && index === 0 ? 'sha256:new-version' : `sha256:version-${index}`,
        },
      }));
      return Response.json({
        ownerUserId: owner,
        period: scope,
        coverage: { state: previewPartial ? 'partial' : 'complete' },
        consistency: { state: previewPartial ? 'uncertain' : 'verified', reasons: [] },
        readWindow: { startedAt: 10, endedAt: 12, consistency: 'independent_source_reads' },
        counts: { week: 26, earlier: 0 },
        requests: previewPartial ? [] : requests,
        personalView: { mode: 'visible', preferenceRevision: 4, originalCount: 26, visibleCount: 26, ignoredCount: 0 },
      });
    }
    if (path === '/api/config/ignored-items') {
      if (init?.method === 'PATCH') {
        if (!unavailableSave && !refuse) {
          const patch: { ignore: (typeof coordinate)[]; restore: (typeof coordinate)[] } = JSON.parse(
            init.body as string,
          );
          preferenceEntries = preferenceEntries.filter(
            (entry) =>
              !patch.restore.some(
                (restored: typeof coordinate) => JSON.stringify(restored) === JSON.stringify(entry.coordinate),
              ),
          );
          for (const ignored of patch.ignore) {
            if (!preferenceEntries.some((entry) => JSON.stringify(entry.coordinate) === JSON.stringify(ignored)))
              preferenceEntries.push({ coordinate: ignored, ignoredAt: 20 });
          }
        }
        return unavailableSave
          ? Response.json({ error: 'Read-only controlled failure' }, { status: 503 })
          : refuse
            ? Response.json({ snapshot: { ownerUserId: owner, revision: 5, entries: [] } }, { status: 409 })
            : Response.json({
                ownerUserId: owner,
                revision: ++revision,
                entries: preferenceEntries,
              });
      }
      return Response.json({ ownerUserId: owner, revision, entries: preferenceEntries });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  mocks.apiFetch.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Mailbox exact personal ignore actions through the original preference lane', () => {
  it.each([
    'zh',
    'en',
  ] as const)('keeps individual handled recovery separate from personal ignore (%s)', async (language) => {
    writeShellLanguage(language);
    history = true;
    if (view.result.kind !== 'ok' || !item.userMention) throw new Error('Fixture');
    view.result.read.mentionPeriod = 'handled';
    view.result.read.items = [{ ...item, userMention: { ...item.userMention, handled: true } }];
    await render();
    await click('mailbox-history-tab-mentions');
    await click('mailbox-item-toggle');
    const restore = document.querySelector('[data-testid="mailbox-mention-restore"]');
    expect(restore).not.toBeNull();
    expect(restore?.textContent).toBe(language === 'en' ? 'Return to to-do' : '放回待办');
    expect(document.querySelector('[data-testid="mailbox-mentions-undo"]')?.textContent).toBe(
      language === 'en' ? 'Undo last handled batch (1 item)' : '撤销刚才的批量处理（1 件）',
    );
    expect(document.querySelector('[data-testid="mailbox-item-ignore"]')).toBeNull();
    expect(document.querySelector('[data-testid="mailbox-item-restore"]')).toBeNull();
    await click('mailbox-mention-restore');
    const calls = mocks.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/api/concierge/work/mentions/restore');
    expect(JSON.parse(calls[0][1].body)).toEqual({
      threadId: 'thread_source',
      messageId: 'message-source',
      expectedRevision: 2,
    });
    expect(writes()).toHaveLength(0);
  });

  it.each([
    'zh',
    'en',
  ] as const)('names the proven empty ignored view instead of pending groups (%s)', async (language) => {
    writeShellLanguage(language);
    mode = 'ignored';
    read();
    if (view.result.kind !== 'ok' || !view.result.read.personalView) throw new Error('Fixture');
    view.result.read.items = [];
    view.result.read.totalCount = 0;
    view.result.read.personalView.originalTotalCount = 0;
    view.result.read.personalView.ignoredTotalCount = 0;
    await render();
    const panel = document.querySelector('[data-testid="mailbox-panel"]');
    expect(panel?.textContent).toContain(language === 'en' ? 'No ignored items yet' : '还没有忽略的事项');
    expect(panel?.textContent).not.toContain(
      language === 'en' ? 'Nothing waiting for your decision' : '暂无等你决定的事',
    );
    expect(panel?.textContent).not.toContain(language === 'en' ? 'No @you requests' : '暂无 @你 请求');
  });

  it('ignores only the server-issued item version without a canonical decision or mention write', async () => {
    await render();
    await click('mailbox-item-toggle');
    expect(document.querySelector('[data-testid="mailbox-item-ignore"]')).not.toBeNull();
    await click('mailbox-item-ignore');
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({
      expectedOwnerUserId: OWNER,
      expectedRevision: 4,
      ignore: [coordinate],
      restore: [],
    });
    expect(mocks.apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(document.querySelector('[data-testid="mailbox-mention-resolve"]')).toBeNull();
    expect(document.querySelector('[data-testid="mailbox-personal-undo"]')).not.toBeNull();
  });
  it('expires only the recent undo receipt while persistent ignored recovery remains available', async () => {
    await render();
    vi.useFakeTimers();
    await click('mailbox-item-ignore');
    expect(document.querySelector('[data-testid="mailbox-personal-undo"]')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11999);
    });
    expect(document.querySelector('[data-testid="mailbox-personal-undo"]')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(document.querySelector('[data-testid="mailbox-personal-undo"]')).toBeNull();
    expect(document.querySelector('[data-testid="mailbox-history"]')).not.toBeNull();
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body).restore).toEqual([]);
    vi.useRealTimers();
    mode = 'ignored';
    read();
    await render();
    await click('mailbox-item-restore');
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(writes()[1][1].body).restore).toEqual([coordinate]);
  });
  it('restores the exact ignored version using the same writer', async () => {
    mode = 'ignored';
    read();
    await render();
    await click('mailbox-item-toggle');
    await click('mailbox-item-restore');
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({
      expectedOwnerUserId: OWNER,
      expectedRevision: 4,
      ignore: [],
      restore: [coordinate],
    });
  });
  it('does not announce success when the preference revision changed', async () => {
    refuse = true;
    await render();
    await click('mailbox-item-toggle');
    await click('mailbox-item-ignore');
    expect(writes()).toHaveLength(1);
    expect(document.querySelector('[data-testid="mailbox-personal-undo"]')).toBeNull();
    expect(document.querySelector('[data-testid="mailbox-personal-notice"]')?.textContent).toContain('有变化');
    expect(view.refetch).toHaveBeenCalled();
  });
  it('previews and confirms all 26 versions across the page boundary before one personal PATCH', async () => {
    if (view.result.kind === 'ok') {
      view.result.read.mentionCounts = { today: 26, week: 26, earlier: 0, handled: 0 };
    }
    await render();
    expect(document.querySelector('[data-testid="mailbox-mentions-ignore-all"]')).not.toBeNull();
    await click('mailbox-mentions-ignore-all');
    expect(writes()).toHaveLength(0);
    expect(document.querySelector('[data-testid="mailbox-mentions-ignore-confirm"]')?.textContent).toContain('26');
    await click('mailbox-mentions-ignore-confirm');
    expect(previewReads).toBe(2);
    expect(writes()).toHaveLength(1);
    const body = JSON.parse(writes()[0][1].body);
    expect(body.expectedOwnerUserId).toBe(OWNER);
    expect(body.expectedRevision).toBe(4);
    expect(body.ignore).toHaveLength(26);
    expect(body.restore).toEqual([]);
    expect(mocks.apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it.each([
    ['zh', 'batch'],
    ['en', 'batch'],
    ['zh', 'ignore'],
    ['en', 'ignore'],
    ['zh', 'restore'],
    ['en', 'restore'],
  ] as const)('retains the actual failed write across a real loading/owner-verification transition (%s/%s)', async (language, action) => {
    writeShellLanguage(language);
    if (action === 'restore') {
      mode = 'ignored';
      read();
    }
    refetchThroughUnconfirmedOwner();
    unavailableSave = true;
    await render();
    if (action === 'batch') {
      await click('mailbox-mentions-ignore-all');
      await click('mailbox-mentions-ignore-confirm');
    } else {
      await click(action === 'restore' ? 'mailbox-item-restore' : 'mailbox-item-ignore');
    }
    expect(writes()).toHaveLength(1);
    expect(view.result.kind).toBe('loading');
    expect(document.querySelector('[data-testid="mailbox-personal-notice"]')).toBeNull();
    await settleSameOwnerRead();
    expect(document.querySelector('[data-testid="mailbox-personal-notice"]')?.textContent).toBe(
      language === 'en'
        ? 'Your ignore preferences could not be verified. Please retry.'
        : '暂时无法确认你的忽略记录，请重试。',
    );
    expect(document.querySelector('[data-testid="mailbox-bulk-ignore-notice"]')).toBeNull();
    expect(
      document.querySelector(
        action === 'restore' ? '[data-testid="mailbox-history-row"]' : '[data-testid="mailbox-mention-preview"]',
      )?.textContent,
    ).toContain('Please look here');
    expect(document.querySelector('[data-testid="mailbox-personal-undo"]')).toBeNull();
    owner = 'different-owner';
    read();
    await render();
    expect(document.querySelector('[data-testid="mailbox-personal-notice"]')).toBeNull();
  });
  it('retains a real CAS conflict after the same refetch transition without replaying the write', async () => {
    refuse = true;
    refetchThroughUnconfirmedOwner();
    await render();
    await click('mailbox-item-ignore');
    expect(view.result.kind).toBe('loading');
    revision = 5;
    await settleSameOwnerRead();
    expect(document.querySelector('[data-testid="mailbox-personal-notice"]')?.textContent).toBe(
      '读取已更新或事项有变化；本次没有保存，请刷新后重新确认。',
    );
    expect(writes()).toHaveLength(1);
  });
  it('also preserves the failed recent-undo write without replacing its owner-fenced receipt', async () => {
    await render();
    await click('mailbox-item-ignore');
    read();
    refetchThroughUnconfirmedOwner();
    await render();
    unavailableSave = true;
    await click('mailbox-personal-undo');
    expect(view.result.kind).toBe('loading');
    await settleSameOwnerRead();
    expect(document.querySelector('[data-testid="mailbox-personal-notice"]')?.textContent).toBe(
      '暂时无法确认你的忽略记录，请重试。',
    );
    expect(document.querySelector('[data-testid="mailbox-personal-undo"]')).not.toBeNull();
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(writes()[1][1].body).restore).toEqual([coordinate]);
  });
  it('does not hide a changed producer version between full-set preview and confirmation', async () => {
    changePreview = true;
    await render();
    await click('mailbox-mentions-ignore-all');
    await click('mailbox-mentions-ignore-confirm');
    expect(previewReads).toBe(2);
    expect(writes()).toHaveLength(0);
    expect(document.querySelector('[data-testid="mailbox-bulk-ignore-notice"]')?.textContent).toContain('有变化');
  });
  it('does not offer a confirmation or a zero claim from a partial full-set preview', async () => {
    previewPartial = true;
    await render();
    await click('mailbox-mentions-ignore-all');
    expect(previewReads).toBe(1);
    expect(writes()).toHaveLength(0);
    expect(document.querySelector('[data-testid="mailbox-mentions-ignore-confirm"]')).toBeNull();
    expect(document.querySelector('[data-testid="mailbox-bulk-ignore-notice"]')?.textContent).toContain('无法');
  });

  it('does not submit a whole-set ignore after the authenticated owner changes', async () => {
    await render();
    await click('mailbox-mentions-ignore-all');
    owner = 'different-owner';
    await click('mailbox-mentions-ignore-confirm');
    expect(writes()).toHaveLength(0);
    expect(document.querySelector('[data-testid="mailbox-bulk-ignore-notice"]')?.textContent).toContain('无法');
  });
  it('explains a preparation withdrawn by a newer read rather than silently doing nothing', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = mocks.apiFetch.getMockImplementation();
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/concierge/work/mentions/handling-preview')) await pending;
      return original?.(path, init);
    });
    await render();
    await click('mailbox-mentions-ignore-all');
    view = { ...view, readsStarted: () => 2 };
    await render();
    await act(async () => {
      release();
    });
    expect(writes()).toHaveLength(0);
    expect(document.querySelector('[data-testid="mailbox-mentions-ignore-confirm"]')).toBeNull();
    expect(document.querySelector('[data-testid="mailbox-bulk-ignore-notice"]')?.textContent).toContain('有变化');
  });
  it('keeps a changed-set explanation across same-owner session verification, but never leaks it to another owner', async () => {
    changePreview = true;
    await render();
    await click('mailbox-mentions-ignore-all');
    await click('mailbox-mentions-ignore-confirm');
    expect(writes()).toHaveLength(0);
    expect(document.querySelector('[data-testid="mailbox-bulk-ignore-notice"]')?.textContent).toContain('有变化');
    const previous = view.result.kind === 'ok' ? view.result.read : null;
    view = { ...view, result: { kind: 'loading' }, staleRead: null, resultGeneration: null, readsStarted: () => 2 };
    await render();
    expect(document.querySelector('[data-testid="mailbox-mentions-ignore-confirm"]')).toBeNull();
    view = { ...view, staleRead: previous };
    await render();
    expect(document.querySelector('[data-testid="mailbox-bulk-ignore-notice"]')?.textContent).toContain('有变化');
    read();
    view = { ...view, resultGeneration: 2, readsStarted: () => 2 };
    await render();
    expect(document.querySelector('[data-testid="mailbox-bulk-ignore-notice"]')?.textContent).toContain('有变化');
    expect(writes()).toHaveLength(0);
    owner = 'different-owner';
    read();
    await render();
    expect(document.querySelector('[data-testid="mailbox-bulk-ignore-notice"]')).toBeNull();
  });
  it('does not attach an old preparation failure to a newly verified owner', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = mocks.apiFetch.getMockImplementation();
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/concierge/work/mentions/handling-preview')) await pending;
      return original?.(path, init);
    });
    await render();
    await click('mailbox-mentions-ignore-all');
    owner = 'newly-verified-owner';
    read();
    await render();
    await act(async () => {
      release();
    });
    expect(writes()).toHaveLength(0);
    expect(document.querySelector('[data-testid="mailbox-mentions-ignore-confirm"]')).toBeNull();
    expect(document.querySelector('[data-testid="mailbox-bulk-ignore-notice"]')).toBeNull();
  });
  it('keeps a visible explanation when a read withdraws an open full-set confirmation', async () => {
    await render();
    await click('mailbox-mentions-ignore-all');
    expect(document.querySelector('[data-testid="mailbox-mentions-ignore-confirm"]')).not.toBeNull();
    const prior = view.result.kind === 'ok' ? view.result.read : null;
    view = { ...view, result: { kind: 'loading' }, staleRead: prior, resultGeneration: null, readsStarted: () => 2 };
    await render();
    expect(writes()).toHaveLength(0);
    expect(document.querySelector('[data-testid="mailbox-mentions-ignore-confirm"]')).toBeNull();
    expect(document.querySelector('[data-testid="mailbox-bulk-ignore-notice"]')?.textContent).toContain('有变化');
  });
  it('uses the decision count for Needs me and exposes personal actions on the collapsed request row', async () => {
    await render();
    expect(document.querySelector('[data-testid="mailbox-tab-count"]')?.textContent).toBe('0');
    const row = document.querySelector('[data-testid="mailbox-item"]');
    expect(row?.getAttribute('data-expanded')).toBe('false');
    expect(row?.querySelector('[data-testid="mailbox-item-ignore"]')).not.toBeNull();
    expect(row?.querySelector('[data-testid="mailbox-open-original"]')).not.toBeNull();
    expect(document.querySelector('#mailbox-bulk-ignore-scope')).toBeNull();
    expect(document.querySelectorAll('[data-testid="mailbox-mentions-ignore-all"]')).toHaveLength(1);
  });
  it.each([
    'visible',
    'ignored',
  ] as const)('uses complete partition group counts across pages instead of total minus attention (%s)', async (selected) => {
    mode = selected;
    read();
    if (view.result.kind !== 'ok' || !view.result.read.personalView) throw new Error('Fixture');
    const readValue = view.result.read;
    readValue.totalCount = selected === 'visible' ? 29 : 25;
    readValue.attentionCount = 1;
    readValue.page.hasMore = true;
    readValue.personalView = {
      mode,
      preferenceRevision: revision,
      originalTotalCount: 54,
      visibleTotalCount: 29,
      ignoredTotalCount: 25,
      originalAttentionCount: 2,
      visibleAttentionCount: 1,
      ignoredAttentionCount: 1,
      groupCounts: {
        original: { decisions: 2, userMentions: 49, other: 3 },
        visible: { decisions: 1, userMentions: 26, other: 2 },
        ignored: { decisions: 1, userMentions: 23, other: 1 },
      },
    };
    await render();
    if (selected === 'ignored') {
      expect(document.querySelector('[data-testid="mailbox-handled-history"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="mailbox-group-mentions"]')).toBeNull();
      expect(document.querySelectorAll('[data-testid="mailbox-history-row"]')).toHaveLength(1);
      return;
    }
    const groups = document.querySelector('[data-testid="mailbox-group-mentions"]');
    expect(document.querySelector('[data-testid="mailbox-state-text"]')?.textContent).toBe(
      `当前范围共 ${selected === 'visible' ? 29 : 25} 件`,
    );
    expect(groups?.querySelector('h3')?.textContent).toContain(selected === 'visible' ? '26' : '23');
    expect(groups?.querySelector('h3')?.textContent).not.toContain('本页');
    expect(document.querySelector('[data-testid="mailbox-group-decisions"] h3')?.textContent).toContain('1');
    expect(document.querySelector('[data-testid="mailbox-group-other"] h3')?.textContent).toContain(
      selected === 'visible' ? '2' : '1',
    );
    if (selected === 'visible')
      expect(document.querySelector('[data-testid="mailbox-tab-count"]')?.textContent).toBe('1');
  });
  it('labels old complete bodies without group counts as page counts rather than exact totals', async () => {
    if (view.result.kind !== 'ok') throw new Error('Fixture');
    view.result.read.page.hasMore = true;
    view.result.read.totalCount = 29;
    await render();
    expect(document.querySelector('[data-testid="mailbox-group-mentions"] h3')?.textContent).toContain('本页 1');
    expect(document.querySelector('[data-testid="mailbox-group-decisions"] h3')?.textContent).toContain('本页 0');
    expect(document.querySelector('[data-testid="mailbox-group-mentions"] h3')?.textContent).not.toContain('29');
  });
  it('does not reuse a partial confirmation read', async () => {
    await render();
    await click('mailbox-mentions-ignore-all');
    previewPartial = true;
    await click('mailbox-mentions-ignore-confirm');
    expect(previewReads).toBe(2);
    expect(writes()).toHaveLength(0);
  });

  it('refuses a write from a stale owner read instead of adopting a newer preference revision', async () => {
    revision = 5;
    await render();
    await click('mailbox-item-toggle');
    await click('mailbox-item-ignore');
    expect(writes()).toHaveLength(0);
  });
});

function knownHealthySources() {
  if (view.result.kind !== 'ok') throw new Error('diagnostic fixture');
  view.result.read.sources.userMentions = { ...source, coverage: 'explicit_user_mentions' };
  view.result.read.sources.collectiveAccountabilityRequests = {
    ...source,
    coverage: 'pending_f290_collective_accountability_requests',
  };
}
function unrelatedCollectiveFailure() {
  knownHealthySources();
  if (view.result.kind !== 'ok') throw new Error('diagnostic fixture');
  const r = view.result.read;
  r.status = 'partial';
  r.sources.collectiveAccountabilityRequests = {
    ...source,
    coverage: 'pending_f290_collective_accountability_requests',
    status: 'unavailable',
    exhaustiveness: 'unknown',
  };
  r.consistency = { state: 'uncertain', reasons: ['collective_accountability_plugin_unavailable'] };
  delete r.totalCount;
  delete r.attentionCount;
  if (r.personalView)
    for (const k of [
      'originalTotalCount',
      'visibleTotalCount',
      'ignoredTotalCount',
      'originalAttentionCount',
      'visibleAttentionCount',
      'ignoredAttentionCount',
      'groupCounts',
    ] as const)
      delete r.personalView[k];
  expect(parseUnifiedAttentionRead(r), 'real unified parser accepts the partial source combination').not.toBeNull();
}
describe('Personal actions keep independent source eligibility', () => {
  it.each([
    'chat selection',
    'approval',
    'linked work',
  ] as const)('known %s personal ignore stays usable during the unrelated plugin outage', async (kind) => {
    unrelatedCollectiveFailure();
    if (view.result.kind !== 'ok') throw new Error('Fixture');
    const row: UnifiedAttentionItemV1 =
      kind === 'linked work'
        ? collectiveResultRow()
        : {
            decisionRef: 'known-decision',
            kind: kind === 'approval' ? 'approval' : 'judgment',
            summary: 'Current owner decision',
            linkedNeedsMe: [],
            ...(kind === 'approval'
              ? { approval: storeItem() }
              : {
                  runtimeInteraction: {
                    interactionId: binding.interactionId,
                    revision: 5,
                    sourceKind: 'conversation_decision' as const,
                    kind: 'conversation_decision' as const,
                    requesterCatId: request.owner.catId,
                    createdAt: request.createdAt,
                    title: request.title,
                    cardRef,
                    presentation: block,
                    allowTextResponse: true,
                  },
                }),
          };
    row.preferenceCoordinate = { ...coordinate, decisionRef: row.decisionRef };
    view.result.read.items = [row];
    await render();
    await click('mailbox-item-toggle');
    await click('mailbox-item-ignore');
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({
      expectedOwnerUserId: OWNER,
      expectedRevision: 4,
      ignore: [row.preferenceCoordinate],
      restore: [],
    });
    expect(mocks.apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
  it('control: healthy exact mention/preferences permits one personal PATCH', async () => {
    knownHealthySources();
    await render();
    await click('mailbox-item-ignore');
    expect(writes()).toHaveLength(1);
  });
  it('unrelated F290 outage must not disable exact @you single ignore', async () => {
    unrelatedCollectiveFailure();
    await render();
    const b = document.querySelector<HTMLButtonElement>('[data-testid="mailbox-item-ignore"]');
    if (!b) throw new Error('Personal action missing');
    expect(b.disabled).toBe(false);
  });
  it('keeps the partial notice and saves the exact mention when the same plugin also makes needs-me partial', async () => {
    unrelatedCollectiveFailure();
    if (view.result.kind !== 'ok') throw new Error('Fixture');
    view.result.read.sources.needsMe = { ...view.result.read.sources.needsMe, exhaustiveness: 'partial' };
    await render();
    const button = document.querySelector<HTMLButtonElement>('[data-testid="mailbox-item-ignore"]');
    expect(button?.disabled).toBe(false);
    expect(view.result.read.status).toBe('partial');
    expect(document.querySelector('[data-testid="mailbox-state-text"]')?.textContent).toContain('仅部分读取');
    await click('mailbox-item-ignore');
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({
      expectedOwnerUserId: OWNER,
      expectedRevision: 4,
      ignore: [coordinate],
      restore: [],
    });
    expect(mocks.apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('unrelated F290 outage must allow full-set authority preview', async () => {
    unrelatedCollectiveFailure();
    await render();
    await click('mailbox-mentions-ignore-all');
    expect(previewReads).toBe(1);
  });
  it('exact ignored mention restore is not disabled by unrelated outage', async () => {
    mode = 'ignored';
    read();
    unrelatedCollectiveFailure();
    await render();
    await click('mailbox-item-toggle');
    const b = document.querySelector<HTMLButtonElement>('[data-testid="mailbox-item-restore"]');
    if (!b) throw new Error('Personal action missing');
    expect(b.disabled).toBe(false);
  });
  it('owner-fenced undo is not disabled solely by unrelated outage', async () => {
    knownHealthySources();
    await render();
    await click('mailbox-item-ignore');
    expect(writes()).toHaveLength(1);
    read();
    unrelatedCollectiveFailure();
    await render();
    const b = document.querySelector<HTMLButtonElement>('[data-testid="mailbox-personal-undo"]');
    if (!b) throw new Error('Personal action missing');
    expect(b.disabled).toBe(false);
  });
  it.each([
    'pointer',
    'keyboard',
  ] as const)('required personal preference proof is unavailable, reason is readable by %s', async (input) => {
    knownHealthySources();
    if (view.result.kind !== 'ok') throw new Error('diagnostic fixture');
    expect(parseUnifiedAttentionRead(view.result.read)).not.toBeNull();
    const original = mocks.apiFetch.getMockImplementation();
    let preferenceReadRefusals = 0;
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/config/ignored-items' && init?.method !== 'PATCH') {
        preferenceReadRefusals++;
        return Response.json({ error: 'Ignored item preferences are unavailable' }, { status: 503 });
      }
      return original?.(path, init);
    });
    await render();
    expect(preferenceReadRefusals).toBe(1);
    const b = document.querySelector<HTMLButtonElement>('[data-testid="mailbox-item-ignore"]');
    if (!b) throw new Error('Personal action missing');
    expect(b.disabled).toBe(true);
    expect(document.querySelector('[data-testid="mailbox-personal-notice"]')?.textContent).toBe(
      '暂时无法确认你的忽略记录，请重试。',
    );
    expect(writes()).toHaveLength(0);
    const target = b.closest<HTMLElement>('[tabindex="0"],[role="button"][aria-disabled="true"]') ?? b;
    vi.useFakeTimers();
    if (input === 'pointer') {
      await act(async () => {
        const event = new Event('pointerover', { bubbles: true });
        Object.defineProperty(event, 'pointerType', { value: 'mouse' });
        target.dispatchEvent(event);
        await vi.advanceTimersByTimeAsync(200);
      });
    } else {
      const matches = Element.prototype.matches;
      const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
        return selector === ':focus-visible' ? this === target : matches.call(this, selector);
      });
      try {
        await act(async () => target.focus());
      } finally {
        spy.mockRestore();
      }
    }
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]');
    const ids = (target.getAttribute('aria-describedby') ?? b.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const description = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    if (input === 'keyboard') expect.soft(document.activeElement).toBe(target);
    expect.soft(tip?.textContent ?? '').toContain('暂时无法确认你的忽略记录');
    expect.soft(description).toContain('暂时无法确认你的忽略记录');
  });
});

describe('Partial reads preserve the personal write boundary', () => {
  it('does not turn an older handled mention without a recorded reason into a viewed claim', async () => {
    history = true;
    read();
    if (view.result.kind !== 'ok') throw new Error('Fixture');
    view.result.read.items = [{ ...item, userMention: { ...item.userMention!, handled: true } }];
    await render();
    const row = document.querySelector('[data-testid="mailbox-history-row"]');
    expect(row?.textContent).toContain('已处理');
    expect(row?.textContent).not.toContain('看过');
  });
  it('clears ignored-history selection when a newer preference revision is installed', async () => {
    mode = 'ignored';
    read();
    await render();
    await click('mailbox-history-select');
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    await act(async () => checkbox?.click());
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    revision++;
    read();
    await render();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.querySelector('[data-testid="mailbox-history-restore-selected"]')).toBeNull();
    expect(writes()).toHaveLength(0);
  });
  it('saves, rereads and restores only the exact mention version while another source is down', async () => {
    unrelatedCollectiveFailure();
    await render();
    await click('mailbox-item-ignore');
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({
      expectedOwnerUserId: OWNER,
      expectedRevision: 4,
      ignore: [coordinate],
      restore: [],
    });
    mode = 'ignored';
    read();
    unrelatedCollectiveFailure();
    await render();
    await click('mailbox-item-toggle');
    await click('mailbox-item-restore');
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(writes()[1][1].body)).toMatchObject({ expectedRevision: 5, ignore: [], restore: [coordinate] });
    expect(preferenceEntries).toEqual([]);
  });
  it('persists all 26 previewed versions and undoes the entire receipt even off the visible page', async () => {
    unrelatedCollectiveFailure();
    await render();
    await click('mailbox-mentions-ignore-all');
    await click('mailbox-mentions-ignore-confirm');
    expect(previewReads).toBe(2);
    expect(writes()).toHaveLength(1);
    const ignored = JSON.parse(writes()[0][1].body).ignore;
    expect(ignored).toHaveLength(26);
    expect(preferenceEntries).toHaveLength(26);
    read();
    unrelatedCollectiveFailure();
    if (view.result.kind !== 'ok') throw new Error('Fixture');
    view.result.read.items = [];
    await render();
    await click('mailbox-personal-undo');
    expect(JSON.parse(writes()[1][1].body).restore).toEqual(ignored);
    expect(preferenceEntries).toEqual([]);
  });
  it.each([
    'mentions',
    'preferences',
    'unknown',
    'empty-reasons',
    'owner',
    'revision',
    'generation',
    'coordinate',
  ] as const)('refuses the partial mention write when %s is unverified', async (failure) => {
    unrelatedCollectiveFailure();
    if (view.result.kind !== 'ok') throw new Error('Fixture');
    const value = view.result.read;
    if (failure === 'mentions')
      value.sources.userMentions = {
        ...source,
        coverage: 'explicit_user_mentions',
        status: 'unavailable',
        exhaustiveness: 'unknown',
      };
    if (failure === 'preferences')
      value.sources.personalPreferences = { ...source, status: 'unavailable', exhaustiveness: 'unknown' };
    if (failure === 'unknown') value.consistency.reasons.push('unrecognized_identity_conflict');
    if (failure === 'empty-reasons') value.consistency.reasons = [];
    if (failure === 'owner') owner = 'different-owner';
    if (failure === 'revision') revision++;
    if (failure === 'generation') view = { ...view, readsStarted: () => 2 };
    if (failure === 'coordinate') value.items = [{ ...item, preferenceCoordinate: undefined }];
    await render();
    await click('mailbox-item-ignore');
    expect(writes()).toHaveLength(0);
  });
  it('keeps non-mention cards conservative under the same outage', async () => {
    unrelatedCollectiveFailure();
    if (view.result.kind !== 'ok') throw new Error('Fixture');
    view.result.read.items = [
      {
        decisionRef: 'other',
        kind: 'judgment',
        summary: 'Work decision',
        linkedNeedsMe: [],
        preferenceCoordinate: { ...coordinate, decisionRef: 'other' },
      },
    ];
    await render();
    await click('mailbox-item-toggle');
    const button = document.querySelector<HTMLButtonElement>('[data-testid="mailbox-item-ignore"]');
    expect(button?.disabled).toBe(true);
    await click('mailbox-item-ignore');
    expect(writes()).toHaveLength(0);
  });
  it('does not restore a missing exact preference or a different producer version', async () => {
    mode = 'ignored';
    read();
    unrelatedCollectiveFailure();
    preferenceEntries = [{ coordinate: { ...coordinate, version: 'sha256:different-version' }, ignoredAt: 20 }];
    await render();
    await click('mailbox-item-toggle');
    await click('mailbox-item-restore');
    expect(writes()).toHaveLength(0);
  });
  it('rechecks source eligibility after a full-set confirmation read is in flight', async () => {
    unrelatedCollectiveFailure();
    await render();
    await click('mailbox-mentions-ignore-all');
    const original = mocks.apiFetch.getMockImplementation();
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/concierge/work/mentions/handling-preview')) await pending;
      return original?.(path, init);
    });
    await click('mailbox-mentions-ignore-confirm');
    read();
    unrelatedCollectiveFailure();
    if (view.result.kind !== 'ok') throw new Error('Fixture');
    view.result.read.consistency.reasons.push('unrecognized');
    await render();
    await act(async () => release());
    expect(writes()).toHaveLength(0);
  });
});
