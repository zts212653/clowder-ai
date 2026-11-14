const assert = require('node:assert/strict');
const test = require('node:test');
const { createDeskDeliveryHost } = require('./desk-delivery-host.cjs');

const turn = () => new Promise((resolve) => setImmediate(resolve));

function line(ref, overrides = {}) {
  return {
    ref,
    revision: 0,
    kind: 'work',
    catId: 'codex61-sol',
    catName: '小太阳',
    byline: 'watcher',
    title: '六猫岛 · 单采肖像参考',
    sentence: '鲸鲸那三格，照他的头像画就行。',
    threadId: 'thread_video',
    threadTitle: '「视频」自媒体视频运营',
    action: 'open',
    createdAt: 1,
    ...overrides,
  };
}

function fixture({ presence = 'present', next = [] } = {}) {
  const calls = { next: [], settle: [] };
  const queue = [...next];
  let settleReply = (input) => ({
    action: input.action,
    items: input.items.map((item) => ({ ref: item.ref, revision: item.revision + 1, outcome: 'settled' })),
    ...(input.action === 'timeout' ? { saved: true } : {}),
  });
  const owner = {
    next: async (returning) => {
      calls.next.push(returning);
      return queue.shift() ?? null;
    },
    settle: async (input) => {
      calls.settle.push(input);
      return settleReply(input);
    },
    avatar: async (catId) => {
      calls.avatar = [...(calls.avatar ?? []), catId];
      return { mediaType: 'image/png', dataBase64: 'iVBORw==', width: 40, height: 40 };
    },
  };
  const state = { presence };
  let changes = 0;
  let n = 0;
  const host = createDeskDeliveryHost({
    owner,
    activity: { presence: () => state.presence },
    onChange: () => changes++,
    newRef: () => `r${++n}`,
  });
  return {
    host,
    calls,
    state,
    changes: () => changes,
    setSettle: (fn) => {
      settleReply = fn;
    },
  };
}

test('at the desk, a nudge brings one work as a single bubble in the public shape', async () => {
  const f = fixture({ next: [{ mode: 'single', items: [line('sugg_1')], more: 0 }] });
  f.host.setVisible(true);
  await turn();
  const { delivery, status, scopeRef } = f.host.snapshot();
  assert.equal(status, 'ready');
  assert.deepEqual(f.calls.next, [false]);
  assert.deepEqual(delivery, {
    deliveryRef: 'r2',
    mode: 'single',
    from: { catId: 'codex61-sol', displayName: '小太阳', role: 'watcher' },
    items: [
      {
        itemRef: 'sugg_1',
        kind: 'work',
        title: '六猫岛 · 单采肖像参考',
        sentence: '鲸鲸那三格，照他的头像画就行。',
        source: { conversationTitle: '「视频」自媒体视频运营' },
        action: 'open',
        thumbnail: false,
      },
    ],
    more: 0,
  });
  assert.equal(scopeRef, 'r1');
});

test('away: a nudge waits; coming back asks for the came-back list once', async () => {
  const f = fixture({
    presence: 'away',
    next: [
      {
        mode: 'bundle',
        items: [
          line('w1'),
          line('o1', { kind: 'suggestion', action: 'add', catId: 'opus55', catName: '宪宪', byline: 'cat' }),
        ],
        more: 2,
      },
    ],
  });
  f.host.setVisible(true);
  f.host.changed();
  await turn();
  assert.deepEqual(f.calls.next, []);
  f.state.presence = 'present';
  f.host.presenceChanged({ presence: 'present', returned: true });
  await turn();
  assert.deepEqual(f.calls.next, [true]);
  const { delivery } = f.host.snapshot();
  assert.equal(delivery.mode, 'bundle');
  assert.equal(delivery.from, null, 'from several cats: the desk cat speaks for itself');
  assert.equal(delivery.more, 2);
});

test('shown keeps the line; 打开 settles it and closes the single bubble; old handles are stale', async () => {
  const f = fixture({ next: [{ mode: 'single', items: [line('sugg_1')], more: 0 }] });
  f.host.setVisible(true);
  await turn();
  const { scopeRef, delivery } = f.host.snapshot();
  const base = { kind: 'desk.settle', scopeRef, deliveryRef: delivery.deliveryRef };
  const shown = await f.host.request({ ...base, action: 'shown' });
  assert.equal(shown.outcome, 'settled');
  assert.deepEqual(f.calls.settle[0], { action: 'shown', items: [{ ref: 'sugg_1', revision: 0 }] });
  const opened = await f.host.request({ ...base, action: 'open', itemRef: 'sugg_1' });
  assert.equal(opened.outcome, 'settled');
  assert.deepEqual(f.calls.settle[1].items, [{ ref: 'sugg_1', revision: 1 }], 'the revision from shown is used');
  assert.equal(f.host.snapshot().delivery, null);
  const again = await f.host.request({ ...base, action: 'open', itemRef: 'sugg_1' });
  assert.equal(again.outcome, 'stale_delivery');
  assert.equal(f.calls.settle.length, 2);
});

test('the countdown running out settles every open line and passes saved through', async () => {
  const f = fixture({ next: [{ mode: 'bundle', items: [line('a'), line('b')], more: 0 }] });
  f.host.setVisible(true);
  await turn();
  const { scopeRef, delivery } = f.host.snapshot();
  const base = { kind: 'desk.settle', scopeRef, deliveryRef: delivery.deliveryRef };
  await f.host.request({ ...base, action: 'open', itemRef: 'a' });
  const timeout = await f.host.request({ ...base, action: 'timeout' });
  assert.equal(timeout.saved, true);
  assert.deepEqual(
    f.calls.settle.at(-1).items.map((item) => item.ref),
    ['b'],
    'only the line nobody answered',
  );
  assert.equal(f.host.snapshot().delivery, null);
});

test('saved is never claimed when the API did not confirm it, and an owner failure keeps the bubble', async () => {
  const f = fixture({ next: [{ mode: 'single', items: [line('a')], more: 0 }] });
  f.host.setVisible(true);
  await turn();
  const { scopeRef, delivery } = f.host.snapshot();
  const base = { kind: 'desk.settle', scopeRef, deliveryRef: delivery.deliveryRef };
  f.setSettle(() => {
    throw new Error('down');
  });
  const failed = await f.host.request({ ...base, action: 'open', itemRef: 'a' });
  assert.equal(failed.outcome, 'failed');
  assert.notEqual(f.host.snapshot().delivery, null);
  f.setSettle((input) => ({ action: input.action, items: [{ ref: 'a', revision: 1, outcome: 'stale' }] }));
  const timeout = await f.host.request({ ...base, action: 'timeout' });
  assert.equal(timeout.saved, undefined);
  assert.equal(timeout.outcome, 'stale_delivery');
});

test('hidden: nothing is shown or asked for, nothing is dropped; showing again brings it back', async () => {
  const f = fixture({ next: [{ mode: 'single', items: [line('a')], more: 0 }] });
  f.host.changed();
  await turn();
  assert.deepEqual(f.calls.next, []);
  assert.equal(f.host.snapshot().status, 'suspended');
  f.host.setVisible(true);
  await turn();
  const deliveryRef = f.host.snapshot().delivery.deliveryRef;
  f.host.setVisible(false);
  assert.equal(f.host.snapshot().delivery, null);
  f.host.setVisible(true);
  assert.equal(f.host.snapshot().delivery.deliveryRef, deliveryRef);
  assert.equal(f.calls.settle.length, 0);
});

test('a nudge while a bubble is up is kept and asked after it closes', async () => {
  const f = fixture({
    next: [
      { mode: 'single', items: [line('a')], more: 0 },
      { mode: 'single', items: [line('b')], more: 0 },
    ],
  });
  f.host.setVisible(true);
  await turn();
  f.host.changed();
  const { scopeRef, delivery } = f.host.snapshot();
  await f.host.request({ kind: 'desk.settle', scopeRef, deliveryRef: delivery.deliveryRef, action: 'dismiss' });
  await turn();
  assert.deepEqual(f.calls.next, [false, false]);
  assert.equal(f.host.snapshot().delivery.items[0].itemRef, 'b');
});

test('the avatar is read only for the bringer of the delivery that is up', async () => {
  const f = fixture({ next: [{ mode: 'single', items: [line('a')], more: 0 }] });
  f.host.setVisible(true);
  await turn();
  const { scopeRef, delivery } = f.host.snapshot();
  const avatar = await f.host.request({ kind: 'desk.avatar.read', scopeRef, deliveryRef: delivery.deliveryRef });
  assert.equal(avatar.kind, 'desk-avatar');
  assert.equal(avatar.image.width, 40);
  assert.deepEqual(f.calls.avatar, ['codex61-sol']);
  const old = await f.host.request({ kind: 'desk.avatar.read', scopeRef, deliveryRef: 'old' });
  assert.equal(old.image, null);
  assert.deepEqual(f.calls.avatar, ['codex61-sol'], 'no read for a delivery that is not up');
});
