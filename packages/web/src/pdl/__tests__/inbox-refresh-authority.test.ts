import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { createOwnerConsole } from './owner-console';

function inbox() {
  const console = createOwnerConsole();
  const events = new Map<string, (detail?: unknown) => unknown>();
  const post = vi.fn(async () => ({ undoId: 'undo' }));
  const action = vi.fn(async () => true);
  let revision = 1;
  let pageOwner = 'owner';
  let fail = false;
  let finish: ((value: unknown) => void) | undefined;
  let defer = false;
  const mention = () => ({
    threadId: 'source',
    messageId: 'mention',
    expectedRevision: revision,
    content: 'Retained body',
    catId: 'codex',
    timestamp: 1,
  });
  const page = () => ({
    identity: { ownerUserId: pageOwner },
    status: 'available',
    attentionCount: 2,
    observedAt: 1,
    page: { hasMore: false },
    items: [
      { decisionRef: 'mention', userMention: mention() },
      {
        decisionRef: 'proposal',
        summary: 'Approval',
        approval: {
          proposalId: 'proposal',
          sourceFeatureId: 'F128',
          resolution: 'open',
          inlineApprovable: true,
          navigation: { state: 'anchored', approvalCardRef: { threadId: 'source', messageId: 'proposal-mid' } },
        },
      },
    ],
  });
  const get = vi.fn(async (path: string, params?: Record<string, string>) => {
    if (path.endsWith('/decisions')) {
      if (params?.mentionPeriod === 'handled')
        return {
          ...page(),
          items: [
            { decisionRef: 'history', userMention: { ...mention(), messageId: 'history', handledReason: 'ignored' } },
          ],
        };
      if (fail) throw new Error('read failed');
      if (defer)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return page();
    }
    if (path.endsWith('/last-handling')) return { receipt: { undoId: 'undo', remaining: 1 } };
    if (path.endsWith('/confirmations')) return { confirmations: [] };
    if (path.endsWith('/handling-preview'))
      return { coverage: { state: 'complete' }, consistency: { state: 'verified' }, requests: [] };
    return { threadId: 'concierge' };
  });
  Object.assign(console.context, {
    api: { get, post, on: (name: string, fn: (detail?: unknown) => unknown) => events.set(name, fn), now: () => 1 },
    BADGES: {},
    ENT: {},
    SET_AFTER: {},
    CHANGES: { cafeSel: vi.fn() },
    heldNeeded: new Set<string>(),
    chatRead: (name: string) =>
      name === 'memberCatalog' ? [] : name === 'chatStream' ? { items: [] } : { handle: 'owner' },
    chatAction: action,
    chatPort: { action },
    chatDataRender: async () => {},
  });
  runInContext(readFileSync('public/pdl-app/inbox.js', 'utf8'), console.context);
  console.read('bindInbox()');
  return {
    ...console,
    post,
    get,
    action,
    events,
    page,
    load: () => console.read("A.refresh({k:'ib-approvals'})") as Promise<unknown>,
    vm: () => console.read('VM.cafeInbox()'),
    set: (options: { revision?: number; defer?: boolean; fail?: boolean; owner?: string }) => {
      revision = options.revision ?? revision;
      pageOwner = options.owner ?? pageOwner;
      defer = options.defer ?? defer;
      fail = options.fail ?? fail;
    },
    finish: (value = page()) => finish!(value),
  };
}
it('retains rows, badges, expansion and choices through refresh/failure but withdraws every write authority', async () => {
  const app = inbox();
  await app.load();
  app.read("CS.ib.open='mention';CS.ib.apPick={'proposal-mid':true}");
  const before = app.vm();
  expect(before.main.at[0]).toMatchObject({ open: true, full: 'Retained body', ctx: { canWrite: true } });
  app.set({ defer: true });
  const refreshing = app.load();
  expect(app.vm()).toMatchObject({
    displayOnly: true,
    main: { at: [{ open: true, full: 'Retained body', ctx: { canWrite: false } }] },
  });
  expect(app.vm().main.decide[0].ctx.canDecide).toBe(false);
  expect(app.read('BADGES.inbox()')).toBe(2);
  for (const expression of [
    "A.cafeIbDone({kind:'mention',t:'source',mid:'mention',revision:1})",
    "A.cafeIbDone({id:'proposal-mid',res:'accept'})",
    "A.cafeIbBatch({res:'accept'})",
    "A.cafeIbUndo({undoId:'undo'})",
    "ENT.ibAt.remove(ENT.ibAt.get('mention'))",
    "ENT.ibIgnored.remove(ENT.ibIgnored.get('history'))",
  ])
    await expect(app.read(expression)).rejects.toThrow('inboxRefresh.retained');
  expect(app.post).not.toHaveBeenCalled();
  expect(app.action).not.toHaveBeenCalled();
  app.set({ revision: 2 });
  app.finish();
  await refreshing;
  expect(app.vm().main.at[0].ctx).toMatchObject({ canWrite: true, expectedRevision: 2 });
  await expect(app.read("A.cafeIbDone({kind:'mention',t:'source',mid:'mention',revision:1})")).rejects.toThrow(
    'inboxRefresh.retained',
  );
  app.set({ defer: false });
  await app.read("A.cafeIbDone({kind:'mention',t:'source',mid:'mention',revision:2})");
  expect(app.post).toHaveBeenCalledWith(
    '/api/concierge/work/mentions/source/resolve',
    {},
    { expectedMessageId: 'mention', expectedRevision: 2 },
  );
});
it('keeps failed reads display-only until a new read confirms retained rows', async () => {
  const app = inbox();
  await app.load();
  app.set({ fail: true });
  await app.load();
  expect(app.read("inboxPendingCount('source')")).toBe(1);
  expect(app.read("inboxPendingLabel('source')")).toBe('pendingDecisions.known');
  expect(app.vm()).toMatchObject({
    displayOnly: true,
    main: { at: [{ text: 'Retained body', ctx: { canWrite: false } }] },
  });
  await expect(app.read("A.cafeIbDone({id:'proposal-mid',res:'accept'})")).rejects.toThrow('inboxRefresh.retained');
  app.set({ fail: false, revision: 3 });
  await app.load();
  expect(app.read("inboxPendingLabel('source')")).toBe('pendingDecisions.count');
  expect(app.vm().main.at[0].ctx).toMatchObject({ canWrite: true, expectedRevision: 3 });
  expect(app.post).not.toHaveBeenCalled();
});
it('withdraws identity authority immediately and rejects an older in-flight read even when it resolves last', async () => {
  const app = inbox();
  await app.load();
  app.set({ defer: true });
  const old = app.load();
  const stale = app.page();
  app.events.get('session:changed')!();
  expect(app.vm().displayOnly).toBe(true);
  expect(app.read("inboxPendingItems('source')")).toEqual([]);
  app.set({ defer: false, revision: 4 });
  await app.load();
  app.finish(stale);
  await old;
  expect(app.vm().main.at[0].ctx).toMatchObject({ canWrite: true, expectedRevision: 4 });
});

it('does not grant write authority to a read from the previous session owner', async () => {
  const app = inbox();
  await app.load();
  expect(app.read("inboxPendingItems('source')")).toMatchObject([{ mid: 'proposal-mid' }]);
  app.events.get('session:changed')!({ ownerUserId: 'next-owner' });
  expect(app.read("inboxPendingCount('source')")).toBe(0);
  expect(app.read("inboxDecisionNotices('source')")).toEqual([]);
  await app.load();
  expect(app.vm().displayOnly).toBe(true);
  await expect(app.read("A.cafeIbDone({kind:'mention',t:'source',mid:'mention',revision:1})")).rejects.toThrow(
    'inboxRefresh.retained',
  );
  app.set({ owner: 'next-owner', revision: 8 });
  await app.load();
  expect(app.vm()).toMatchObject({
    displayOnly: false,
    main: { at: [{ ctx: { canWrite: true, expectedRevision: 8 } }] },
  });
  expect(app.get).toHaveBeenCalledWith('/api/concierge/confirmations', undefined, { afterCurrentGet: true });
});
