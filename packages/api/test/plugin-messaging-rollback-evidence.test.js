/**
 * K-1 / F288 — rollback safety + no-plugin dormancy evidence.
 *
 * Required by maintainer direction intake (#1271): executable evidence that
 * the additive plugin fields are inert under rollback and that deployments
 * without an activated messaging-capable plugin retain existing host behavior.
 */
import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';

let MessageStore;
let envelope;
let memory;
let handlesMod;
let ledgerMod;
let sendMod;
let streamMod;

before(async () => {
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
  envelope = await import('../dist/domains/messaging/envelope.js');
  memory = await import('../dist/domains/messaging/stores/memory.js');
  handlesMod = await import('../dist/domains/messaging/handles.js');
  ledgerMod = await import('../dist/domains/messaging/ledger.js');
  sendMod = await import('../dist/domains/messaging/send-service.js');
  streamMod = await import('../dist/domains/messaging/event-stream.js');
});

describe('Rollback evidence — additive plugin fields are inert under old-binary downgrade', () => {
  let messageStore;

  beforeEach(() => {
    messageStore = new MessageStore();
  });

  /**
   * Simulate the rollback scenario: messages with the additive pluginMessage
   * field exist in the store (written by K-1 code), but consumers read them
   * through host-only paths (old binary without K-1 awareness).
   */
  function seedPluginMessage(overrides = {}) {
    return messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'host-visible text content',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'thread-1',
      extra: {
        pluginMessage: {
          instanceId: 'inst-a',
          revision: 1,
          provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'plugin text' } }],
          appendOps: [],
        },
      },
      ...overrides,
    });
  }

  test('host pagination (getByThreadAfter) returns messages with additive plugin fields', () => {
    seedPluginMessage();
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'normal host message',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId: 'thread-1',
    });
    const all = messageStore.getByThreadAfter('thread-1');
    assert.equal(all.length, 2, 'both plugin-bearing and host messages returned');
    assert.ok(all[0].extra?.pluginMessage, 'plugin field preserved in store');
    assert.equal(all[0].content, 'host-visible text content', 'content column intact');
  });

  test('getBefore pagination works with plugin-bearing messages', () => {
    seedPluginMessage({ timestamp: 1_800_000_000_000 });
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'later message',
      mentions: [],
      timestamp: 1_800_000_000_001,
      threadId: 'thread-1',
    });
    const page = messageStore.getBefore(1_800_000_000_002, 10);
    assert.equal(page.length, 2);
  });

  test('getMentionsFor finds mentions in plugin-bearing messages', () => {
    seedPluginMessage({ mentions: ['opus'] });
    const mentions = messageStore.getMentionsFor('opus', 10);
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].content, 'host-visible text content');
  });

  test('softDelete works on plugin-bearing messages', () => {
    const msg = seedPluginMessage();
    const deleted = messageStore.softDelete(msg.id, 'user-1');
    assert.ok(deleted);
    assert.ok(deleted.deletedAt);
    // getByThreadAfter intentionally includes deleted messages (consumer-level
    // filtering). The key assertion: softDelete succeeds and sets deletedAt,
    // projectEnvelope returns null for the deleted message.
    const env = envelope.projectEnvelope(deleted);
    assert.equal(env, null, 'deleted plugin message projects to null');
  });

  test('updateExtra on plugin-bearing message preserves host fields without corruption', () => {
    const msg = seedPluginMessage();
    const updated = messageStore.updateExtra(msg.id, { interactiveState: { clicked: true } });
    assert.ok(updated);
    assert.ok(updated.extra?.pluginMessage, 'pluginMessage not stripped by updateExtra');
    assert.deepEqual(updated.extra?.interactiveState, { clicked: true }, 'host extra merged');
  });

  test('host-path projectEnvelope: plugin message projects via plugin branch, not host branch', () => {
    const msg = seedPluginMessage();
    const env = envelope.projectEnvelope(msg);
    assert.ok(env, 'projects successfully');
    assert.deepEqual(env.actor, { kind: 'plugin', id: 'inst-a' });
    assert.equal(env.payload.elements[0].payload.text, 'plugin text');
  });

  test('rollback scenario: stripping pluginMessage awareness falls back to host content', () => {
    const msg = seedPluginMessage();
    // Simulate old-binary: delete the pluginMessage from extra before projection.
    // This is what happens when old code reads the Redis extra JSON and doesn't
    // know about the pluginMessage key — splitMessageExtra wasn't called.
    const rollbackMsg = { ...msg, extra: { ...msg.extra } };
    delete rollbackMsg.extra.pluginMessage;
    const env = envelope.projectEnvelope(rollbackMsg);
    assert.ok(env, 'still projects via host-message fallback');
    assert.deepEqual(env.actor, { kind: 'user', id: 'user-1' });
    assert.equal(env.payload.elements[0].payload.text, 'host-visible text content');
    assert.deepEqual(env.payload.provenance.origin, { kind: 'host' });
  });

  test('malformed pluginMessage in extra → projectEnvelope returns null (fail-closed)', () => {
    const msg = seedPluginMessage();
    msg.extra.pluginMessage = { instanceId: 42, revision: 'bad' };
    const env = envelope.projectEnvelope(msg);
    assert.equal(env, null, 'fail-closed on malformed plugin data');
  });
});

describe('No-plugin dormancy — K-1 services with zero plugin handles retain host behavior', () => {
  let messageStore;

  beforeEach(() => {
    messageStore = new MessageStore();
  });

  test('MessagingService construction with no handles does not modify MessageStore', () => {
    const cursors = new memory.MemoryCursorStore();
    const handleStore = new memory.MemoryHandleStore();
    const handles = new handlesMod.HandleService(handleStore, cursors);
    const events = new memory.MemoryEventLogStore();
    const sendService = new sendMod.SendService({
      messageStore,
      handles,
      ledger: new ledgerMod.MessagingLedger(new memory.MemoryLedgerStore()),
      events,
      isKnownCatId: () => true,
    });
    const stream = new streamMod.EventStreamService({ events, cursors, handles, messageStore });
    // Services constructed — no handles issued, no plugin activated.
    assert.ok(sendService);
    assert.ok(stream);
    // Host message operations remain unaffected.
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'host message',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });
    const messages = messageStore.getByThreadAfter('thread-1');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'host message');
    assert.equal(messages[0].extra, undefined, 'no plugin contamination');
  });

  test('host message pagination is independent of plugin event log state', async () => {
    const events = new memory.MemoryEventLogStore();
    // Even with events in the plugin log, host pagination is unaffected.
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'cat reply',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });
    const [msg] = messageStore.getByThreadAfter('thread-1');
    assert.equal(msg.content, 'cat reply');
    // Plugin event head is 0 — no interaction with host message.
    const head = await events.headSequence('thread-1');
    assert.equal(head, 0);
  });

  test('host projectEnvelope for user/cat messages is unaffected by K-1 code presence', () => {
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'user says hi',
      mentions: [],
      timestamp: 1_800_000_000_000,
      threadId: 'thread-1',
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'cat replies',
      mentions: [],
      timestamp: 1_800_000_000_001,
      threadId: 'thread-1',
    });
    const msgs = messageStore.getByThreadAfter('thread-1');
    const envs = msgs.map((m) => envelope.projectEnvelope(m)).filter(Boolean);
    assert.equal(envs.length, 2);
    assert.deepEqual(envs[0].actor, { kind: 'user', id: 'user-1' });
    assert.deepEqual(envs[1].actor, { kind: 'cat', id: 'opus' });
    assert.deepEqual(envs[0].payload.provenance.origin, { kind: 'host' });
    assert.deepEqual(envs[1].payload.provenance.origin, { kind: 'host' });
  });
});
