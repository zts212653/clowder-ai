import { type IgnoredItemSnapshot, ignoredItemKey, type UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { type UnifiedAttentionView, useUnifiedAttention } from '../../use-unified-attention';
import { createHandledHistoryRead } from '../handled-history-read';
import { MailboxHandledHistory } from '../MailboxHandledHistory';
import { useMailboxPersonalPreferences } from '../use-mailbox-personal-preferences';
import { OWNER, okRead } from './mailbox-fixtures';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: api }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));
const items: UnifiedAttentionItemV1[] = Array.from({ length: 40 }, (_, i) => ({
  decisionRef: `user-mention:legacy-${i}`,
  kind: 'user_mention',
  summary: `Legacy ${i}`,
  linkedNeedsMe: [],
  preferenceCoordinate: { kind: 'mailbox', decisionRef: `user-mention:legacy-${i}`, version: `sha256:version-${i}` },
  userMention: {
    threadId: `legacy-${i}`,
    messageId: `m-${i}`,
    catId: 'codex61-sol',
    timestamp: 1,
    content: `Legacy ${i}`,
    expectedRevision: 1,
  },
}));
let prefs: IgnoredItemSnapshot;
let failWrite: boolean;
let preferenceRead: IgnoredItemSnapshot | 'unavailable' | undefined;
let latest: UnifiedAttentionView;
let root: Root;
let host: HTMLDivElement;
const history = createHandledHistoryRead();
function App() {
  const view = useUnifiedAttention();
  latest = view;
  const personal = useMailboxPersonalPreferences(view);
  return (
    <MailboxHandledHistory
      section="ignored"
      view={view}
      personal={personal}
      snapshot={null}
      read={history}
      onOpenPlace={vi.fn()}
      verifyCurrent={() => view.resultGeneration === view.readsStarted()}
    />
  );
}
const click = (id: string, within: ParentNode = host) =>
  act(async () => {
    const button = within.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    expect(button, id).not.toBeNull();
    button?.click();
  });
const row = (i: number) => host.querySelector<HTMLElement>(`[data-decision-ref="user-mention:legacy-${i}"]`);
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  observeApiSessionOwner(OWNER);
  failWrite = false;
  preferenceRead = undefined;
  prefs = {
    ownerUserId: OWNER,
    revision: 1,
    entries: items.map((item) => ({ coordinate: item.preferenceCoordinate!, ignoredAt: 10 })),
  };
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/session') return Response.json({ userId: OWNER });
    if (path === '/api/config/ignored-items') {
      if (!init?.method && preferenceRead === 'unavailable') return Response.json({}, { status: 503 });
      if (!init?.method && preferenceRead) return Response.json(preferenceRead);
      if (init?.method === 'PATCH') {
        if (failWrite) return Response.json({ error: 'unavailable' }, { status: 503 });
        const patch = JSON.parse(init.body as string);
        expect(patch.expectedOwnerUserId).toBe(OWNER);
        expect(patch.expectedRevision).toBe(prefs.revision);
        prefs = {
          ...prefs,
          revision: prefs.revision + 1,
          entries: prefs.entries.filter(
            (entry) =>
              !patch.restore.some(
                (coordinate: IgnoredItemSnapshot['entries'][number]['coordinate']) =>
                  ignoredItemKey(coordinate) === ignoredItemKey(entry.coordinate),
              ),
          ),
        };
      }
      return Response.json(prefs);
    }
    if (path.startsWith('/api/concierge/work/decisions?')) {
      const q = new URL(path, 'https://fixture.test').searchParams;
      const mode = q.get('personalView') === 'ignored' ? 'ignored' : 'visible';
      const offset = Number(q.get('offset'));
      const keys = new Set(prefs.entries.map((entry) => ignoredItemKey(entry.coordinate)));
      const ignored = items.filter((item) => keys.has(ignoredItemKey(item.preferenceCoordinate!)));
      const visible = mode === 'ignored' ? ignored : [];
      const result = okRead(visible.slice(offset, offset + 20));
      if (result.kind !== 'ok') throw new Error('fixture');
      Object.assign(result.read, {
        mentionPeriod: q.get('mentionPeriod') ?? 'week',
        totalCount: visible.length,
        attentionCount: 0,
        page: { offset, limit: 20, scope: 'known_rows', hasMore: offset + 20 < visible.length },
        personalView: {
          mode,
          preferenceRevision: prefs.revision,
          originalTotalCount: 40,
          visibleTotalCount: 40 - ignored.length,
          ignoredTotalCount: ignored.length,
          originalAttentionCount: 0,
          visibleAttentionCount: 0,
          ignoredAttentionCount: 0,
        },
      });
      const source = { status: 'available' as const, startedAt: 1, observedAt: 2, exhaustiveness: 'complete' as const };
      result.read.sources.personalPreferences = { ...source, coverage: 'owner_personal_ignored_items' };
      result.read.sources.userMentions = { ...source, coverage: 'explicit_user_mentions' };
      return Response.json(result.read);
    }
    throw new Error(`Unexpected ${path}`);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  api.mockReset();
  vi.unstubAllGlobals();
  localStorage.clear();
});
async function openSecondPage() {
  await act(async () => root.render(<App />));
  await act(async () => latest.setPersonalView?.('ignored'));
  expect(host.querySelectorAll('[data-testid="mailbox-history-row"]')).toHaveLength(20);
  await click('mailbox-history-load-more');
  expect(host.querySelectorAll('[data-testid="mailbox-history-row"]')).toHaveLength(40);
  expect(latest.currentPages).toHaveLength(2);
}
it.each([
  false,
  true,
])('removes restored continuation versions after a real preference write (batch=%s), retaining other cached rows', async (batch) => {
  await openSecondPage();
  if (batch) {
    await click('mailbox-history-select');
    await act(async () => {
      row(20)?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
      row(21)?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    });
    await click('mailbox-history-restore-selected');
  } else {
    await click('mailbox-history-item-toggle', row(20)!);
    await click('mailbox-item-restore', row(20)!);
  }
  expect(prefs.revision).toBe(2);
  expect(prefs.entries).toHaveLength(batch ? 38 : 39);
  expect(latest.pages).toHaveLength(2);
  expect(latest.currentPages).toHaveLength(1);
  expect(row(20), 'a saved restore cannot keep this exact version labelled ignored').toBeNull();
  if (batch) expect(row(21)).toBeNull();
  expect(row(39), 'other old continuation rows stay readable').not.toBeNull();
  expect(host.querySelectorAll('[data-testid="mailbox-history-row"]')).toHaveLength(batch ? 38 : 39);
  await click('mailbox-history-item-toggle', row(39)!);
  expect(row(39)?.querySelector<HTMLButtonElement>('[data-testid="mailbox-item-restore"]')?.disabled).toBe(true);
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
});
it('keeps the ignored continuation row after a refused preference write', async () => {
  await openSecondPage();
  failWrite = true;
  await click('mailbox-history-item-toggle', row(20)!);
  await click('mailbox-item-restore', row(20)!);
  expect(prefs.revision).toBe(1);
  expect(prefs.entries).toHaveLength(40);
  expect(row(20)).not.toBeNull();
});
it.each([
  'older',
  'other-owner',
  'unavailable',
] as const)('does not remove cached rows using %s preference evidence or allow a restore with it', async (kind) => {
  await openSecondPage();
  preferenceRead =
    kind === 'unavailable'
      ? 'unavailable'
      : { ownerUserId: kind === 'other-owner' ? 'owner-2' : OWNER, revision: 0, entries: [] };
  await act(async () => window.dispatchEvent(new Event('cat-cafe:ignored-item-preferences-updated')));
  expect(row(20)).not.toBeNull();
  expect(host.querySelectorAll('[data-testid="mailbox-history-row"]')).toHaveLength(40);
  await click('mailbox-history-item-toggle', row(20)!);
  expect(row(20)?.querySelector<HTMLButtonElement>('[data-testid="mailbox-item-restore"]')?.disabled).toBe(true);
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
});
it('does not treat a different version of the same decision as evidence that the old version is still ignored', async () => {
  await openSecondPage();
  preferenceRead = {
    ...prefs,
    revision: 2,
    entries: prefs.entries.map((entry, i) =>
      i === 20 ? { ...entry, coordinate: { ...entry.coordinate, version: 'sha256:new-version' } } : entry,
    ),
  };
  await act(async () => window.dispatchEvent(new Event('cat-cafe:ignored-item-preferences-updated')));
  expect(row(20)).toBeNull();
  expect(row(39)).not.toBeNull();
  expect(host.querySelectorAll('[data-testid="mailbox-history-row"]')).toHaveLength(39);
  expect(api.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
});
