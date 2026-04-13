import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createDeliverFn, createLifecycleToastFn } from '../dist/infrastructure/scheduler/delivery.js';

describe('createDeliverFn', () => {
  it('appends connector message to store and broadcasts connector_message via socket', async () => {
    const appendResult = { id: 'msg-1', threadId: 'th-1', timestamp: 1234567890 };
    const messageStore = { append: mock.fn(() => appendResult) };
    const socketManager = { broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
    const deliver = createDeliverFn({ messageStore, socketManager });

    const msgId = await deliver({
      threadId: 'th-1',
      content: 'Hello reminder',
      userId: 'user-1',
      extra: { scheduler: { hiddenTrigger: true } },
    });

    assert.equal(msgId, 'msg-1');
    assert.equal(messageStore.append.mock.calls.length, 1);
    const appendArg = messageStore.append.mock.calls[0].arguments[0];
    assert.equal(appendArg.threadId, 'th-1');
    assert.equal(appendArg.content, 'Hello reminder');
    assert.equal(appendArg.catId, null);
    assert.equal(appendArg.origin, 'callback');
    assert.equal(appendArg.source.connector, 'scheduler');
    assert.equal(appendArg.source.label, '定时任务');
    assert.equal(appendArg.extra.scheduler.hiddenTrigger, true);
    assert.equal(socketManager.broadcastToRoom.mock.calls.length, 1);
    const [room, event, payload] = socketManager.broadcastToRoom.mock.calls[0].arguments;
    assert.equal(room, 'thread:th-1');
    assert.equal(event, 'connector_message');
    assert.equal(payload.threadId, 'th-1');
    assert.equal(payload.message.content, 'Hello reminder');
    assert.equal(payload.message.source.connector, 'scheduler');
    assert.equal(payload.message.extra.scheduler.hiddenTrigger, true);
  });

  it('returns message id from store', async () => {
    const messageStore = { append: mock.fn(() => ({ id: 'msg-42' })) };
    const socketManager = { broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
    const deliver = createDeliverFn({ messageStore, socketManager });

    const msgId = await deliver({
      threadId: 'th-2',
      content: 'test',
      userId: 'u-1',
    });
    assert.equal(msgId, 'msg-42');
  });

  it('works with async messageStore.append', async () => {
    const messageStore = { append: mock.fn(async () => ({ id: 'msg-async' })) };
    const socketManager = { broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
    const deliver = createDeliverFn({ messageStore, socketManager });

    const msgId = await deliver({
      threadId: 'th-3',
      content: 'async test',
      userId: 'u-1',
    });
    assert.equal(msgId, 'msg-async');
  });
});

describe('createLifecycleToastFn', () => {
  it('emits scheduler lifecycle toast via user-scoped connector_message without persistence', () => {
    const socketManager = { broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
    const emitLifecycleToast = createLifecycleToastFn({ socketManager });

    emitLifecycleToast({
      threadId: 'thread-toast',
      userId: 'user-42',
      toast: {
        type: 'info',
        title: '定时任务已创建',
        message: '「喝水提醒」下次执行时间：2026-04-13 09:00:00',
        duration: 3200,
        lifecycleEvent: 'registered',
      },
    });

    assert.equal(socketManager.broadcastToRoom.mock.calls.length, 0);
    assert.equal(socketManager.emitToUser.mock.calls.length, 1);
    const [userId, event, payload] = socketManager.emitToUser.mock.calls[0].arguments;
    assert.equal(userId, 'user-42');
    assert.equal(event, 'connector_message');
    assert.equal(payload.threadId, 'thread-toast');
    assert.equal(payload.message.source.connector, 'scheduler');
    assert.equal(payload.message.extra.scheduler.toast.title, '定时任务已创建');
    assert.equal(payload.message.extra.scheduler.toast.lifecycleEvent, 'registered');
  });
});
