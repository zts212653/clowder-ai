import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HomeActionController,
  type HomeActionRequest,
  type HomeActionTarget,
} from '../src/domains/concierge/action/HomeActionController.js';

function fixture() {
  let request: HomeActionRequest | null = {
    messageId: 'direct-owner-request',
    userId: 'owner',
    callId: 'call',
    revision: 'r1',
    text: '打开雪山计划那段对话',
    signal: new AbortController().signal,
  };
  let targets: readonly HomeActionTarget[] = [
    { id: 'opaque-1', label: '雪山计划', operation: 'click', revision: 'target-r1' },
  ];
  const executions: string[] = [];
  const records: string[] = [];
  const ports = {
    currentRequest: async () => request,
    targets: async () => targets,
    select: async () => ({ kind: 'act' as const, targetId: 'opaque-1', operation: 'click' as const }),
    execute: async () => {
      executions.push('owner');
      return { status: 'applied' as const };
    },
    record: async (_request: HomeActionRequest, result: { status: string }) => {
      records.push(result.status);
    },
  };
  return {
    ports,
    executions,
    records,
    setRequest: (next: HomeActionRequest | null) => {
      request = next;
    },
    setTargets: (next: readonly HomeActionTarget[]) => {
      targets = next;
    },
    getRequest: () => {
      assert.ok(request);
      return request;
    },
  };
}

test('an unfamiliar real owner target is selected and executed once; simultaneous callback reads share the result', async () => {
  const f = fixture();
  const controller = new HomeActionController(f.ports);
  const results = await Promise.all([controller.run(), controller.run()]);
  assert.equal(results[0]?.status, 'applied');
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(f.executions, ['owner']);
  assert.deepEqual(f.records, ['applied']);
});

for (const status of ['queued', 'blocked', 'unconfirmed'] as const)
  test(`owner ${status} receipt remains ${status}; no success inference or retry`, async () => {
    const f = fixture();
    const ports = {
      ...f.ports,
      execute: async () => {
        f.executions.push('owner');
        return { status };
      },
    };
    const controller = new HomeActionController(ports);
    assert.equal((await controller.run())?.status, status);
    assert.equal((await controller.run())?.status, status);
    assert.equal(f.executions.length, 1);
  });

test('a new direct input arriving while Jev selects prevents the old operation', async () => {
  const f = fixture();
  const ports = {
    ...f.ports,
    select: async () => {
      f.setRequest({ ...f.getRequest(), messageId: 'new-request', text: '不要打开了' });
      return { kind: 'act' as const, targetId: 'opaque-1', operation: 'click' as const };
    },
  };
  assert.equal((await new HomeActionController(ports).run())?.status, 'stale');
  assert.deepEqual(f.executions, []);
  assert.deepEqual(f.records, ['stale'], 'retain the cancelled request outcome as a durable fact');
});

test('revoked or renamed targets cannot borrow a previous candidate label', async () => {
  const f = fixture();
  const ports = {
    ...f.ports,
    select: async () => {
      f.setTargets([{ id: 'opaque-1', label: '另一个目标', operation: 'click', revision: 'target-r2' }]);
      return { kind: 'act' as const, targetId: 'opaque-1', operation: 'click' as const };
    },
  };
  assert.equal((await new HomeActionController(ports).run())?.status, 'stale');
  assert.deepEqual(f.executions, []);
});

test('Jev cannot create an inaccessible target or change a click into a fill', async () => {
  const f = fixture();
  const ports = {
    ...f.ports,
    select: async () => ({ kind: 'act' as const, targetId: 'not-offered', operation: 'click' as const }),
  };
  assert.equal((await new HomeActionController(ports).run())?.status, 'blocked');
  assert.deepEqual(f.executions, []);
  assert.deepEqual(f.records, ['blocked'], 'a rejected selection also needs its original outcome');
});

test('an ambiguous owner request asks without executing; closing during selection is stale', async () => {
  const f = fixture();
  assert.equal(
    (await new HomeActionController({ ...f.ports, select: async () => ({ kind: 'ask', reason: '哪段对话？' }) }).run())
      ?.status,
    'ask',
  );
  assert.deepEqual(f.executions, []);
  let controller: HomeActionController;
  controller = new HomeActionController({
    ...f.ports,
    select: async () => {
      controller.close();
      return { kind: 'act', targetId: 'opaque-1', operation: 'click' };
    },
  });
  assert.equal((await controller.run())?.status, 'stale');
});

test('a draft value invented by selection never reaches its owner', async () => {
  const f = fixture();
  f.setTargets([{ id: 'opaque-1', label: '当前草稿', operation: 'fill', revision: 'draft-r1' }]);
  const controller = new HomeActionController({
    ...f.ports,
    select: async () => ({ kind: 'act', targetId: 'opaque-1', operation: 'fill', value: 'invented' }),
  });
  assert.equal((await controller.run())?.status, 'blocked');
  assert.deepEqual(f.executions, []);
});
