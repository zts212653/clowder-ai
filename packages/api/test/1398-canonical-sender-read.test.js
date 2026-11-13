import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectInvocationSource } from '../dist/domains/cats/services/agents/routing/navigation-sources.js';
import { formatMessage, getMessageSpeakerName } from '../dist/domains/cats/services/context/ContextAssembler.js';
import { projectMessageSearchSpeaker } from '../dist/domains/memory/message-search-projection.js';

const external = {
  id: 'external-event',
  userId: 'owner',
  catId: null,
  from: { kind: 'external', connectorId: 'github-wait' },
  source: { connector: 'github-wait', label: 'GitHub Wait', icon: 'github' },
  content: '@opus CI changed',
  mentions: ['opus'],
  timestamp: 2000,
};

test('MCP speaker and prompt use the same canonical external identity', () => {
  assert.equal(getMessageSpeakerName(external), 'GitHub Wait');
  assert.ok(formatMessage(external).includes('GitHub Wait'));
  assert.ok(!formatMessage(external).includes('co-creator'));
});

test('external input provenance carries no hold or custody instruction', () => {
  const source = projectInvocationSource(external);
  assert.deepEqual(source, { fromMessageId: external.id, fromSpeakerDisplay: 'GitHub Wait', timestamp: 2000 });
});

test('plugin without connector metadata retains plugin identity in navigation and reads', () => {
  const message = { ...external, source: undefined, from: { kind: 'plugin', instanceId: 'plugin-example' } };
  assert.equal(projectInvocationSource(message).fromSpeakerDisplay, '插件');
  assert.equal(getMessageSpeakerName(message), '插件');
  assert.deepEqual(projectMessageSearchSpeaker(message), { speaker: 'connector', speakerLabel: '插件' });
});

test('canonical actor overrides legacy catId and unrelated source metadata', () => {
  const message = {
    ...external,
    catId: 'opus',
    from: { kind: 'external', connectorId: 'feed', sender: { id: 'actor-id', name: 'Alice' } },
    source: { connector: 'wrong', label: 'co-creator', icon: 'github', sender: { id: 'owner', name: 'lang' } },
  };
  assert.equal(getMessageSpeakerName(message), 'Alice via feed');
  assert.equal(projectInvocationSource(message).fromSpeakerDisplay, 'Alice via feed');
});

test('persisted plugin presentation supplies model context and export labels without raw IDs', async () => {
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const store = new MessageStore();
  const from = { kind: 'plugin', instanceId: 'pi_private-routing-id' };
  const msg = store.append({
    userId: 'owner',
    threadId: 'thread',
    from,
    content: 'hello',
    timestamp: 2000,
    mentions: [],
    extra: {
      pluginMessage: {
        instanceId: from.instanceId,
        revision: 1,
        provenance: { origin: from, epistemicStatus: 'observation' },
        elements: [],
        presentation: { connector: 'custom', label: 'Room Connector', icon: 'message', themeColor: '#07c160' },
      },
    },
  });
  assert.equal(msg.source, undefined);
  assert.equal(getMessageSpeakerName(msg), 'Room Connector');
  assert.ok(formatMessage(msg).includes('Room Connector'));
  assert.ok(!formatMessage(msg).includes(from.instanceId));
});
