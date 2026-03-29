import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createDeliverFn } from '../dist/infrastructure/scheduler/delivery.js';

describe('createDeliverFn', () => {
  it('appends message to store and broadcasts via socket', async () => {
    const appendResult = { id: 'msg-1', threadId: 'th-1' };
    const messageStore = { append: mock.fn(() => appendResult) };
    const socketManager = { broadcastAgentMessage: mock.fn() };
    const deliver = createDeliverFn({ messageStore, socketManager });

    const msgId = await deliver({
      threadId: 'th-1',
      content: 'Hello reminder',
      catId: 'opus',
      userId: 'user-1',
    });

    assert.equal(msgId, 'msg-1');
    assert.equal(messageStore.append.mock.calls.length, 1);
    const appendArg = messageStore.append.mock.calls[0].arguments[0];
    assert.equal(appendArg.threadId, 'th-1');
    assert.equal(appendArg.content, 'Hello reminder');
    assert.equal(appendArg.catId, 'opus');
    assert.equal(appendArg.origin, 'callback');
    assert.equal(appendArg.source.connector, 'scheduler');
    assert.equal(appendArg.source.label, '定时任务');
    assert.equal(socketManager.broadcastAgentMessage.mock.calls.length, 1);
    const broadcastArg = socketManager.broadcastAgentMessage.mock.calls[0].arguments;
    assert.equal(broadcastArg[0].content, 'Hello reminder');
    assert.equal(broadcastArg[0].source.connector, 'scheduler');
    assert.equal(broadcastArg[1], 'th-1');
  });

  it('returns message id from store', async () => {
    const messageStore = { append: mock.fn(() => ({ id: 'msg-42' })) };
    const socketManager = { broadcastAgentMessage: mock.fn() };
    const deliver = createDeliverFn({ messageStore, socketManager });

    const msgId = await deliver({
      threadId: 'th-2',
      content: 'test',
      catId: 'opus',
      userId: 'u-1',
    });
    assert.equal(msgId, 'msg-42');
  });

  it('works with async messageStore.append', async () => {
    const messageStore = { append: mock.fn(async () => ({ id: 'msg-async' })) };
    const socketManager = { broadcastAgentMessage: mock.fn() };
    const deliver = createDeliverFn({ messageStore, socketManager });

    const msgId = await deliver({
      threadId: 'th-3',
      content: 'async test',
      catId: 'opus',
      userId: 'u-1',
    });
    assert.equal(msgId, 'msg-async');
  });
});
