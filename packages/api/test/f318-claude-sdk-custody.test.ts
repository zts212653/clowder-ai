import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFreshnessCarrierCapability } from '@cat-cafe/shared';
import { createQueueLedgerAdmission } from '../src/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.js';
import { hydrateQueueLedgerEntry } from '../src/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerCodec.js';

test('SDK capability survives the canonical Queue ledger without upgrading delivery semantics', () => {
  const capability = {
    provider: 'anthropic',
    carrier: 'claude_agent_sdk',
    deliverySemantics: 'queued_internal_turn',
    activeInvocationGuidance: 'supported',
  } as const;
  const [entry] = createQueueLedgerAdmission({
    sourceId: 'sdk-source',
    threadId: 'sdk-thread',
    owner: { kind: 'user', userId: 'owner' },
    kind: 'conversation_input',
    from: { kind: 'user', userId: 'owner' },
    targetCatIds: ['opus'],
    content: 'guide current work',
    intent: 'execute',
    ownerAuthProvenance: 'strict',
    enqueuedAt: 1,
    authorIntentByCatId: { opus: { requested: 'next_work', carrierCapability: capability } },
  });
  assert.ok(entry);
  const restored = hydrateQueueLedgerEntry(JSON.stringify(entry));
  assert.deepEqual(restored.delivery.authorIntentByTarget?.opus, {
    requested: 'next_work',
    carrierCapability: capability,
  });
  assert.deepEqual(restored.targets, ['opus']);
  assert.equal(parseFreshnessCarrierCapability({ ...capability, carrier: 'unregistered-carrier' }), undefined);
});
