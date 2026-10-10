/**
 * #1398 P1 — canonical actor identity for an external input is the PERSON, not the room.
 *
 * `ConnectorSource` carries two different facts: `label` is the chat's display name
 * ("Feishu群聊 · Team") and `sender` is the human who typed ("Alice"). `from.sender` is the
 * canonical actor identity every downstream consumer reads — message-bundle author grouping keys
 * on `external:{connectorId}:{sender.id}`, streaming receipts and Queue projection address it, and
 * the envelope maps it to `{kind:'user', id}`. Deriving it from `label` collapses every member of a
 * group chat into one pseudo-person named after the room.
 *
 * This test observes production's real seam: the real ConnectorRouter handing an envelope to the
 * real PersistedQueueDelivery. The ConnectorRouter unit mock synthesizes `from` itself and so
 * cannot see this class of defect at all.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { ConnectorRouter } from '../dist/infrastructure/connectors/ConnectorRouter.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';
import { InboundMessageDedup } from '../dist/infrastructure/connectors/InboundMessageDedup.js';
import { connectorDeliveryHarness } from './helpers/connector-delivery-harness.js';

function noopLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => noopLog() };
}

function mockThreadStore() {
  let counter = 0;
  const threads = new Map();
  return {
    threads,
    create(userId, title, projectPath) {
      counter += 1;
      const thread = {
        id: `thread-${counter}`,
        createdBy: userId,
        title,
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
        projectPath: projectPath ?? 'default',
      };
      threads.set(thread.id, thread);
      return thread;
    },
    async get(threadId) {
      return threads.get(threadId) ?? null;
    },
    updateConnectorHubState() {},
    async getParticipantsWithActivity() {
      return [];
    },
    updateProjectPath(threadId, projectPath) {
      const thread = threads.get(threadId);
      if (thread) thread.projectPath = projectPath;
    },
  };
}

function ensureMentionRegistry() {
  if (catRegistry.tryGet('opus')) return;
  catRegistry.register('opus', {
    id: 'opus',
    name: 'opus',
    displayName: '布偶猫',
    avatar: '/avatars/opus.png',
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: ['@opus', '@布偶猫', '@布偶', '@宪宪'],
    provider: 'anthropic',
    defaultModel: 'test-model',
    mcpSupport: false,
    roleDescription: 'test role',
    personality: 'test personality',
  });
}

describe('#1398 connector admission keeps the real sender as canonical actor identity', () => {
  let harness;
  let router;

  beforeEach(() => {
    ensureMentionRegistry();
    harness = connectorDeliveryHarness();
    router = new ConnectorRouter({
      bindingStore: new MemoryConnectorThreadBindingStore(),
      dedup: new InboundMessageDedup(),
      messageStore: harness.messageStore,
      persistedQueueDelivery: harness.delivery,
      threadStore: mockThreadStore(),
      socketManager: { broadcastToRoom() {} },
      defaultUserId: 'user_1',
      defaultCatId: 'opus',
      log: noopLog(),
    });
  });

  it('persists the person, not the group label, on both Message and Queue entry', async () => {
    const result = await router.route(
      'feishu',
      'chat_team',
      'hello cats',
      'msg_alice_1',
      undefined,
      { id: 'ou_alice', name: 'Alice' },
      'group',
      'Team',
    );
    assert.equal(result.kind, 'routed');

    const stored = harness.messageStore.getById(result.messageId);
    assert.ok(stored, 'the input must be durably persisted');
    // The room name is a display label and must never impersonate the actor.
    assert.notEqual(stored.from.sender?.id, stored.source.label);
    assert.deepEqual(stored.from.sender, { id: 'ou_alice', name: 'Alice' });

    const [entry] = harness.admitted(result.threadId);
    assert.ok(entry, 'the input must be durably admitted to the Queue');
    assert.deepEqual(entry.from.sender, { id: 'ou_alice', name: 'Alice' });
  });

  it('distinguishes two people in the same group chat instead of collapsing them into the room', async () => {
    const first = await router.route(
      'feishu',
      'chat_team',
      'from alice',
      'msg_a',
      undefined,
      { id: 'ou_alice', name: 'Alice' },
      'group',
      'Team',
    );
    const second = await router.route(
      'feishu',
      'chat_team',
      'from bob',
      'msg_b',
      undefined,
      { id: 'ou_bob', name: 'Bob' },
      'group',
      'Team',
    );

    const authorKey = (messageId) => {
      const msg = harness.messageStore.getById(messageId);
      return `external:${msg.from.connectorId}:${msg.from.sender?.id ?? 'unknown'}`;
    };
    assert.equal(authorKey(first.messageId), 'external:feishu:ou_alice');
    assert.equal(authorKey(second.messageId), 'external:feishu:ou_bob');
    assert.notEqual(authorKey(first.messageId), authorKey(second.messageId));
  });

  it('omits sender rather than inventing one when the producer supplies no person', async () => {
    const result = await router.route('feishu', 'chat_solo', 'ping', 'msg_solo', undefined, undefined, 'p2p');
    const stored = harness.messageStore.getById(result.messageId);
    assert.equal(stored.from.kind, 'external');
    assert.equal(stored.from.connectorId, 'feishu');
    // No person was supplied: an absent sender is honest; a label-shaped one is a fabricated actor.
    assert.equal(stored.from.sender, undefined);
  });
});
