import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBatonContext } from '../dist/domains/cats/services/agents/routing/navigation-context.js';
import { formatMessage, getMessageSpeakerName } from '../dist/domains/cats/services/context/ContextAssembler.js';

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
  assert.equal(getMessageSpeakerName(message), 'plugin-example');
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
