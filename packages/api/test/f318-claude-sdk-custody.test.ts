import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQueuedMessageCustody } from '../src/domains/cats/services/stores/ports/queued-message-custody.js';
import { makeQueuedMessageCustody } from './helpers/queued-message-custody.js';

test('SDK capability survives durable queue custody without upgrading delivery semantics', () => {
  const capability = {
    provider: 'anthropic',
    carrier: 'claude_agent_sdk',
    deliverySemantics: 'queued_internal_turn',
  };
  const custody = makeQueuedMessageCustody({
    authorIntentByCatId: { opus: { requested: 'next_work', carrierCapability: capability } },
  });
  assert.deepEqual(parseQueuedMessageCustody(JSON.stringify(custody))?.authorIntentByCatId?.opus, {
    requested: 'next_work',
    carrierCapability: capability,
  });
  custody.authorIntentByCatId.opus.carrierCapability.carrier = 'unregistered-carrier';
  assert.throws(() => parseQueuedMessageCustody(JSON.stringify(custody)), /carrier/);
});
