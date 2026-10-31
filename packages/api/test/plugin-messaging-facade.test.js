/**
 * K-1 / F288 — MessagingService facade end-to-end (plan Task 9)
 * The K-2 broker consumption surface: one object, full chain
 * issue → send → subscribe → read → ack → append → read → snapshot.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let facadeMod;
let MessageStore;
let messageStore;
let service;

const CTX = { pluginInstanceId: 'inst-a' };

beforeEach(async () => {
  facadeMod = await import('../dist/domains/messaging/messaging-service.js');
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
  messageStore = new MessageStore();
  service = facadeMod.createMessagingDomain({ messageStore });
});

describe('MessagingService facade — full chain', () => {
  test('issue → send → subscribe → read → ack → append → read → snapshot', async () => {
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: true },
    });

    const { subscriptionId } = await service.subscribe(CTX, handleId);

    const sendReceipt = await service.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'e2e-1',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hello e2e' } }],
      },
    });
    assert.equal(sendReceipt.revision, 1);

    const read1 = await service.read(CTX, subscriptionId, {});
    assert.equal(read1.events.length, 1);
    assert.equal(read1.events[0].type, 'message.publish');
    await service.ack(CTX, subscriptionId, read1.ackToken);

    assert.ok(sendReceipt.messageHandle, 'SendReceipt must include an opaque message handle');
    assert.notEqual(
      sendReceipt.messageHandle.token,
      sendReceipt.messageId,
      'handle token must be opaque (not messageId)',
    );

    const appendReceipt = await service.appendElements(CTX, {
      handle: sendReceipt.messageHandle,
      operationId: 'e2e-op-1',
      baseRevision: 1,
      elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'appended e2e' }, derivedFromElementId: 'el-1' }],
    });
    assert.equal(appendReceipt.revision, 2);

    const read2 = await service.read(CTX, subscriptionId, {});
    assert.equal(read2.events.length, 1);
    assert.equal(read2.events[0].type, 'message.elements.append');
    assert.equal(read2.events[0].revision, 2);
    await service.ack(CTX, subscriptionId, read2.ackToken);

    const snap = await service.snapshot(CTX, subscriptionId);
    assert.equal(snap.envelopes.length, 1);
    assert.equal(snap.envelopes[0].revision, 2);
    assert.equal(snap.envelopes[0].payload.elements.length, 2);
  });

  test('revokeHandle cuts both send and read paths', async () => {
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: true },
    });
    const { subscriptionId } = await service.subscribe(CTX, handleId);
    await service.revokeHandle(handleId);
    await assert.rejects(
      service.send(CTX, {
        address: { kind: 'thread_handle', handle: handleId },
        idempotencyKey: 'after-revoke',
        payload: {
          provenance: { epistemicStatus: 'inference' },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
        },
      }),
      (err) => err.code === 'PERMISSION',
    );
    await assert.rejects(service.read(CTX, subscriptionId, {}), (err) => err.code === 'PERMISSION');
  });

  test('append authority follows both the message handle and its parent address handle', async () => {
    const parent = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: true },
    });
    const first = await service.send(CTX, {
      address: { kind: 'thread_handle', handle: parent.handleId },
      idempotencyKey: 'append-parent-revoke',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'mine' } }],
      },
    });
    await service.revokeHandle(parent.handleId);
    await assert.rejects(
      service.appendElements(CTX, {
        handle: first.messageHandle,
        operationId: 'blocked-by-parent-revoke',
        elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'blocked' } }],
      }),
      (err) => err.code === 'PERMISSION',
    );

    const secondParent = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: true },
    });
    const second = await service.send(CTX, {
      address: { kind: 'thread_handle', handle: secondParent.handleId },
      idempotencyKey: 'append-message-revoke',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'mine' } }],
      },
    });
    await service.revokeHandle(second.messageHandle.token);
    await assert.rejects(
      service.appendElements(CTX, {
        handle: second.messageHandle,
        operationId: 'blocked-by-message-revoke',
        elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'blocked' } }],
      }),
      (err) => err.code === 'PERMISSION',
    );
  });

  test('cross-plugin isolation end-to-end: inst-b sees nothing of inst-a', async () => {
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: true },
    });
    const sent = await service.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'iso-1',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'mine' } }],
      },
    });
    const foreign = { pluginInstanceId: 'inst-b' };
    await assert.rejects(service.subscribe(foreign, handleId), (err) => err.code === 'PERMISSION');
    await assert.rejects(
      service.appendElements(foreign, {
        handle: sent.messageHandle,
        operationId: 'steal-1',
        elements: [{ elementId: 'el-x', kind: 'text', payload: { text: 'not mine' } }],
      }),
      (err) => err.code === 'PERMISSION',
    );
  });
});
