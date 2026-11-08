import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contextEpochScopeKey } from '../../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { WorkPreparationAuthority } from '../../dist/domains/memory/cue/preparation/WorkPreparationAuthority.js';

// Real canonical in-memory owners; no fixture principal grants access across owner or context boundaries.
test('Host binds the exact trigger, strict owner, project and current context epoch', async () => {
  const threads = new ThreadStore();
  const messages = new MessageStore();
  const epochs = new InMemoryContextEpochStore();
  const thread = threads.create('owner', 'Prepare', '/fixture');
  const message = messages.append({
    userId: 'owner',
    threadId: thread.id,
    from: { kind: 'user', userId: 'owner' },
    mentions: [],
    content: 'Make this memo HTML',
    timestamp: 1000,
  });
  const key = contextEpochScopeKey({ userId: 'owner', threadId: thread.id, catId: 'codex61-sol' });
  epochs.compareAndPut(
    { scopeKey: key, contextEpoch: 1, contextMode: 'hot', lastTransitionRef: 'launch', version: 1, updatedAt: 1000 },
    0,
  );
  const auth = {
    userId: 'owner',
    catId: 'codex61-sol',
    threadId: thread.id,
    invocationId: 'inv',
    originTriggerMessageId: message.id,
    ownerAuthProvenance: 'strict',
    state: 'active',
  };
  const authority = new WorkPreparationAuthority({ threads, messages, epochs });
  const valid = await authority.bind(auth);
  assert.equal(valid?.sourceMessageId, message.id);
  assert.equal(valid?.projectPath, '/fixture');
  assert.equal(valid?.contextEpoch, 1);
  for (const change of [
    { ownerAuthProvenance: 'unknown' },
    { userId: 'other' },
    { threadId: 'other' },
    { originTriggerMessageId: 'missing' },
    { state: 'revoked' },
  ])
    assert.equal(await authority.bind({ ...auth, ...change }), null);
  assert.ok(valid);
  const record = {
    ...valid,
    opportunityId: 'preparation-test',
    activity: 'html',
    queryDigest: 'digest',
    occurredAt: 1000,
    expiresAt: 10000,
  };
  assert.equal(await authority.validate(record), true);
  epochs.compareAndPut(
    {
      scopeKey: key,
      contextEpoch: 2,
      contextMode: 'cold',
      lastTransitionRef: 'compacted',
      version: 2,
      updatedAt: 2000,
    },
    1,
  );
  assert.equal(await authority.validate(record), false);
  assert.equal((await authority.bind(auth))?.contextEpoch, 2);
});
