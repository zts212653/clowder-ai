import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { readPreparationEvidence } from '../dist/infrastructure/capability-evolution/read-model/program-preparation-evidence.js';
import { objectBody } from './helpers/capability-evolution-preparation-bodies.js';

test('object source reading preserves exact refs and fences missing, foreign and unsupported evidence', async () => {
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const thread = await threadStore.create('operator', 'Exact sources', '/repo');
  const message = messageStore.append({
    userId: 'operator',
    threadId: thread.id,
    catId: 'codex-astra',
    content: 'Original method boundary',
    mentions: [],
    timestamp: 1,
  });
  const body = objectBody();
  const source = { ownerFeatureId: 'F117', ownerStateRef: `message:${message.id}` };
  const historical = { ownerFeatureId: 'F311', ownerStateRef: `git:${'a'.repeat(40)}:method/old.md` };
  body.items[0].sourceRefs = [source, historical];
  const before = structuredClone(body);
  const dependencies = { messageStore, threadStore };
  const [read] = await readPreparationEvidence(body, 'operator', dependencies);
  assert.equal(read?.sourceKey, body.items[0].itemId);
  assert.deepEqual(read.refs[0], { ref: source, status: 'available', threadId: thread.id, messageId: message.id });
  assert.deepEqual(read.refs[1], { ref: historical, status: 'unverified' });
  assert.equal(read.status, 'unverified');
  const [foreign] = await readPreparationEvidence(body, 'other-user', dependencies);
  assert.equal(foreign.refs[0].status, 'unavailable');
  assert.equal(foreign.refs[0].threadId, undefined);
  messageStore.softDelete(message.id, 'operator');
  const [missing] = await readPreparationEvidence(body, 'operator', dependencies);
  assert.equal(missing.refs[0].status, 'unavailable');
  assert.equal(missing.refs[0].messageId, undefined);
  assert.deepEqual(body, before);
});
