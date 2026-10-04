import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { FreshnessAttentionEvent } from '../src/domains/cats/services/freshness/FreshnessAttentionEventLog.js';
import {
  bindFreshnessNoticeBroker,
  FreshnessNoticeBroker,
} from '../src/domains/cats/services/freshness/FreshnessNoticeBroker.js';

test('idle notice uses the shared frontier, records only a real accepted turn, and defers a busy native race', async () => {
  const events: FreshnessAttentionEvent[] = [];
  const controller = bindFreshnessNoticeBroker(
    new FreshnessNoticeBroker({
      context: { invocationId: 'live', threadId: 'home', catId: createCatId('codex-astra') },
      checkUnseen: async () => ({ count: 1, maxMessageId: 'new-source', noticeDedupKey: 'queue-entry-v1' }),
      appendEvent: async (event) => {
        events.push(event);
      },
    }),
    { provider: 'openai_codex', carrier: 'codex_app_server', deliverySemantics: 'exact_active_turn' },
  );
  assert.ok(controller.idle);
  const first = await controller.idle.prepare();
  assert.ok(first);
  assert.equal('expectedTurnId' in first, false);
  assert.equal(await controller.prepare({ threadId: 'home', turnId: 'active', toolSurface: 'mcp_tool_call' }), null);
  controller.idle.defer(first);
  const second = await controller.idle.prepare();
  assert.ok(second, 'a rejected idle start cannot consume the queued frontier');
  await controller.idle.commitDelivered(second, { acceptedTurnId: 'native-turn-accepted' });
  assert.equal(await controller.idle.prepare(), null);
  const delivered = events.find((event) => event.kind === 'provider_notice_delivered');
  assert.equal(delivered?.boundaryKind, 'idle_start');
  assert.equal(delivered?.deliverySemantics, 'queued_internal_turn');
  assert.equal(delivered?.expectedTurnId, undefined);
  assert.equal(delivered?.acceptedTurnId, 'native-turn-accepted');
  assert.equal(
    events.some((event) => event.kind === 'provider_notice_seen' || event.kind === 'provider_notice_handled'),
    false,
  );
});
