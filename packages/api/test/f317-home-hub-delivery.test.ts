import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { HomeHubDelivery } from '../src/domains/concierge/live/host/home/home-hub-delivery.js';
import { homeComposerLiteralValues, homeHubTargets } from '../src/domains/concierge/live/host/home/home-hub-targets.js';

function fixture() {
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = threads.create('owner', '/project');
  threads.updateTitle(thread.id, '松林旅行安排');
  const controller = new AbortController();
  const request = {
    userId: 'owner',
    callId: 'call',
    messageId: 'direct-source',
    revision: 'r1',
    text: '打开松林旅行那段对话',
    signal: controller.signal,
  };
  const state = {
    clientId: randomUUID(),
    clientToken: '',
    route: '/',
    threadId: thread.id,
    composer: true,
    sections: [{ id: 'plugins', label: '插件集成' }],
  };
  let current = true;
  let onExecute: (token: string) => Promise<unknown[]> = async () => [];
  let states: unknown[] = [state];
  const delivery = new HomeHubDelivery({
    messages,
    threads,
    isCurrent: async () => current,
    emitter: {
      emit: () => {},
      emitWithAck: async (_owner, event, data) =>
        event === 'home:inspect' ? states : onExecute((data as { token: string }).token),
    },
  });
  state.clientToken = delivery.registerClient('owner', state.clientId).clientToken;
  return {
    messages,
    threads,
    thread,
    state,
    request,
    delivery,
    controller,
    setCurrent: (value: boolean) => {
      current = value;
    },
    setStates: (value: unknown[]) => {
      states = value;
    },
    setConsumer: (value: typeof onExecute) => {
      onExecute = value;
    },
  };
}

test('owner-visible unfamiliar thread is offered, an unindexed foreign thread is absent, and distinct visible Hubs keep separate owner targets for selection', async () => {
  const f = fixture();
  const foreign = f.threads.create('another-owner', '/project');
  f.threads.updateTitle(foreign.id, '不该显示的目标');
  const targets = await f.delivery.targets(f.request);
  assert.ok(targets.some((t) => t.label === '打开对话：松林旅行安排'));
  assert.ok(!targets.some((t) => t.label.includes('不该显示')));
  const otherWindow = randomUUID();
  f.setStates([
    f.state,
    { ...f.state, clientId: otherWindow, clientToken: f.delivery.registerClient('owner', otherWindow).clientToken },
  ]);
  assert.deepEqual(
    new Set((await f.delivery.targets(f.request)).map((target) => target.clientId)),
    new Set([f.state.clientId, otherWindow]),
  );
});

test('navigation needs one matching current capability and a real consumer receipt, not just an emitted event', async () => {
  const f = fixture();
  const target = (await f.delivery.targets(f.request)).find((t) => t.ownerAction.kind === 'thread');
  assert.ok(target);
  const choice = { kind: 'act' as const, targetId: target.id, operation: 'click' as const };
  assert.equal((await f.delivery.execute(f.request, target, choice)).status, 'unconfirmed');
  f.setConsumer(async (token) => {
    const grant = await f.delivery.consume('owner', token, f.state.clientId, f.state.clientToken);
    assert.ok(grant && typeof grant === 'object' && 'kind' in grant);
    assert.equal(grant.kind, 'navigate');
    assert.deepEqual(await f.delivery.consume('owner', token, f.state.clientId, f.state.clientToken), {
      kind: 'blocked',
      reason: 'already_consumed',
    });
    return [{ token, clientId: f.state.clientId, clientToken: f.state.clientToken, status: 'applied' }];
  });
  assert.equal((await f.delivery.execute(f.request, target, choice)).status, 'applied');
});

test('a stale source, changed Hub route, foreign window or forged ACK cannot authorize an effect', async () => {
  const f = fixture();
  const target = (await f.delivery.targets(f.request))[0];
  f.setConsumer(async (token) => {
    assert.deepEqual(await f.delivery.consume('other-owner', token, f.state.clientId, f.state.clientToken), {
      kind: 'blocked',
    });
    assert.deepEqual(await f.delivery.consume('owner', token, randomUUID(), f.state.clientToken), { kind: 'blocked' });
    f.setCurrent(false);
    assert.deepEqual(await f.delivery.consume('owner', token, f.state.clientId, f.state.clientToken), {
      kind: 'stale',
    });
    return [{ token, clientId: f.state.clientId, clientToken: f.state.clientToken, status: 'applied' }];
  });
  assert.equal(
    (await f.delivery.execute(f.request, target, { kind: 'act', targetId: target.id, operation: 'click' })).status,
    'blocked',
  );
  assert.equal(f.messages.getOwnerComposerDraft('owner', f.thread.id), null);
});

test('draft consume uses flushed owner revision once and preserves attachments; source revoked after selection cannot write', async () => {
  const f = fixture();
  f.messages.putOwnerComposerDraft('owner', f.thread.id, {
    expectedRevision: 0,
    text: '原草稿',
    contentBlocks: [{ type: 'image', url: '/kept.png' }],
    updatedAt: Date.now(),
  });
  f.request.text = '在输入框写入「带伞」';
  const target = (await f.delivery.targets(f.request)).find((t) => t.ownerAction.kind === 'draft');
  assert.ok(target);
  f.setConsumer(async (token) => {
    const grant = await f.delivery.consume('owner', token, f.state.clientId, f.state.clientToken, 1);
    assert.ok(grant && typeof grant === 'object' && 'kind' in grant);
    assert.equal(grant.kind, 'updated');
    return [{ token, clientId: f.state.clientId, clientToken: f.state.clientToken, status: 'applied' }];
  });
  const choice = { kind: 'act' as const, targetId: target.id, operation: 'fill' as const, value: '带伞' };
  assert.equal((await f.delivery.execute(f.request, target, choice)).status, 'applied');
  assert.equal(f.messages.getOwnerComposerDraft('owner', f.thread.id)?.text, '原草稿\n带伞');
  assert.deepEqual(f.messages.getOwnerComposerDraft('owner', f.thread.id)?.contentBlocks, [
    { type: 'image', url: '/kept.png' },
  ]);
  assert.deepEqual(f.messages.getByThread(f.thread.id), []);
  f.setCurrent(false);
  assert.equal((await f.delivery.execute(f.request, target, choice)).status, 'stale');
});

test('the final Hub adapter refuses a forged fill even if an internal caller bypasses the selector', async () => {
  const f = fixture();
  const target = (await f.delivery.targets(f.request)).find((t) => t.ownerAction.kind === 'draft');
  assert.ok(target);
  f.setConsumer(async (token) => {
    await f.delivery.consume('owner', token, f.state.clientId, f.state.clientToken, 0);
    return [{ token, clientId: f.state.clientId, clientToken: f.state.clientToken, status: 'applied' }];
  });
  assert.equal(
    (
      await f.delivery.execute(f.request, target, {
        kind: 'act',
        targetId: target.id,
        operation: 'fill',
        value: 'invented',
      })
    ).status,
    'blocked',
  );
  assert.equal(f.messages.getOwnerComposerDraft('owner', f.thread.id), null);
});

test('literal composer syntax preserves the exact requested span; discovery never invents an executable coordinate from text', () => {
  assert.deepEqual(homeComposerLiteralValues('帮我在输入框放一句：下雨也要去散步'), ['下雨也要去散步']);
  assert.deepEqual(homeComposerLiteralValues('不要在输入框放一句：下雨也要去散步'), []);
  assert.deepEqual(
    homeHubTargets(
      { clientId: randomUUID(), clientToken: '', route: '/', threadId: 'unavailable', composer: true, sections: [] },
      [],
      '写点什么',
    ),
    [],
  );
});

test('an anonymous socket cannot offer executable Hub targets without an owner-issued window capability', async () => {
  const f = fixture();
  f.setStates([{ ...f.state, clientId: randomUUID() }]);
  assert.deepEqual(await f.delivery.targets(f.request), []);
});

test('an anonymous ACK cannot replace the registered window outcome after a legitimate owner consume', async () => {
  const f = fixture();
  const target = (await f.delivery.targets(f.request))[0];
  f.setConsumer(async (token) => {
    const grant = await f.delivery.consume('owner', token, f.state.clientId, f.state.clientToken);
    assert.ok(grant && typeof grant === 'object' && 'kind' in grant && grant.kind === 'navigate');
    return [
      { token, clientId: f.state.clientId, clientToken: randomUUID(), status: 'applied' },
      { token, clientId: f.state.clientId, clientToken: f.state.clientToken, status: 'unconfirmed' },
    ];
  });
  const result = await f.delivery.execute(f.request, target, { kind: 'act', targetId: target.id, operation: 'click' });
  assert.equal(result.status, 'unconfirmed');
});
