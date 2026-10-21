import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBatonContext } from '../dist/domains/cats/services/agents/routing/navigation-context.js';
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

test('external handoff cannot supersede an operator hold through author confusion', () => {
  const owner = {
    ...external,
    id: 'owner-stop',
    from: { kind: 'user', userId: 'owner' },
    source: undefined,
    content: '请稍等，别动',
    mentions: [],
    timestamp: 1000,
  };
  const baton = extractBatonContext([owner, external], 'opus');
  assert.equal(baton.staleHoldWarning, false);
  assert.equal(baton.fromSpeaker, 'external:github-wait:');
});

test('plugin without connector metadata retains plugin identity in navigation and reads', () => {
  const message = { ...external, source: undefined, from: { kind: 'plugin', instanceId: 'plugin-example' } };
  assert.equal(extractBatonContext([message], 'opus').fromSpeaker, 'plugin:plugin-example');
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
  assert.equal(extractBatonContext([message], 'opus').fromSpeaker, 'external:feed:actor-id');
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
