import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

/**
 * #1398 — connector delivery composition.
 *
 * The producer-unification migration moved every connector producer onto one atomic
 * `Message + Queue` admission (`deliverConnectorMessage` → `PersistedQueueDeliveryPort`). The
 * migration's real failure mode was never a wrong algorithm; it was a wrong *wiring* that no gate
 * could see:
 *
 *   - `index.ts` assembled the repo-scan deps into a `Record<string, unknown>`, which erased the
 *     `ConnectorDeliveryDeps` contract, so `deliveryDeps: { messageStore }` type-checked cleanly
 *     while the runtime path needed `{ delivery }`.
 *   - `GitHubRepoWebhookHandler` papered over a missing port with `?? ({} as ConnectorDeliveryDeps)`,
 *     turning a composition bug into an undefined-property crash inside a scheduled task.
 *
 * Both are now structurally impossible (the deps objects carry their real types again), but types
 * only guard the paths TypeScript can see. This file pins the runtime half: a mis-wired producer
 * must fail loudly and name the actual defect, and a correctly wired one must reach the port.
 */
describe('#1398 connector delivery composition', () => {
  let deliverConnectorMessage;

  before(async () => {
    ({ deliverConnectorMessage } = await import('../dist/infrastructure/email/deliver-connector-message.js'));
  });

  const input = () => ({
    threadId: 'thread_compose',
    userId: 'user-1',
    catId: 'opus',
    content: 'hello',
    source: 'github-repo-event',
    idempotencyKey: 'github-repo-event:compose-1',
  });

  it('rejects the pre-unification `{ messageStore }` wiring with a diagnostic naming the defect', async () => {
    // Exactly the object index.ts used to hand the repo-scan reconciliation path.
    const misWired = { messageStore: { append: async () => ({ id: 'm1' }) } };

    await assert.rejects(
      () => deliverConnectorMessage(misWired, input()),
      (err) => {
        // The point of the guard: it must not surface as "cannot read properties of undefined".
        assert.match(err.message, /mis-wired/i);
        assert.match(err.message, /github-repo-event/);
        assert.match(err.message, /PersistedQueueDeliveryPort/);
        assert.match(err.message, /MessageStore/);
        return true;
      },
    );
  });

  it('rejects an empty deps object instead of pretending it is a delivery port', async () => {
    // The shape the webhook handler's `?? ({} as ConnectorDeliveryDeps)` fallback used to fabricate.
    await assert.rejects(() => deliverConnectorMessage({}, input()), /mis-wired/i);
    await assert.rejects(() => deliverConnectorMessage(undefined, input()), /mis-wired/i);
  });

  it('reaches the port and reports admission once the delivery dep is real', async () => {
    const seen = [];
    const delivery = {
      deliver: async (envelope) => {
        seen.push(envelope);
        return { state: 'queued', message: { id: 'msg-1' } };
      },
    };

    const result = await deliverConnectorMessage({ delivery }, input());

    assert.equal(result.admitted, true);
    assert.equal(result.messageId, 'msg-1');
    assert.equal(seen.length, 1);
    // The idempotency key is the admission identity — it must survive the hop unchanged.
    assert.equal(seen[0].idempotencyKey, 'github-repo-event:compose-1');
    assert.equal(seen[0].targetCatId, 'opus');
    assert.equal(seen[0].ownerUserId, 'user-1');
  });

  it('reports a non-admission for the two states that never reached the Queue', async () => {
    for (const state of ['conflict', 'unavailable']) {
      const delivery = { deliver: async () => ({ state }) };
      const result = await deliverConnectorMessage({ delivery }, input());
      assert.equal(result.admitted, false, `${state} must not be reported as admitted`);
    }
  });

  it('treats an idempotent replay of already-claimed work as a durable admission', async () => {
    for (const state of ['claimed', 'done', 'queued']) {
      const delivery = { deliver: async () => ({ state, message: { id: 'msg-replay' } }) };
      const result = await deliverConnectorMessage({ delivery }, input());
      assert.equal(result.admitted, true, `${state} is durable and must settle the producer's outbox`);
    }
  });
});
