import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviderNativeFreshnessFactory } from '../src/domains/cats/services/freshness/createProviderNativeFreshnessFactory.ts';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { DeliveryCursorStore } from '../src/domains/cats/services/stores/ports/DeliveryCursorStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';

test('expected replies require an active result consumer, independently of exposure filtering', async () => {
  const events = [];
  const transaction = {
    rpush(_key, value) {
      events.push(JSON.parse(value));
      return this;
    },
    expire() {
      return this;
    },
    zadd() {
      return this;
    },
    zremrangebyscore() {
      return this;
    },
    async exec() {
      return [[null, 1]];
    },
  };
  const store = new MessageStore();
  const cursors = new DeliveryCursorStore();
  const base = { userId: 'owner', threadId: 'home', catId: null, content: 'start', mentions: [], timestamp: 1 };
  const seed = store.append(base);
  await cursors.ackSeenCursor('owner', 'codex-astra', 'home', cursorFor(seed));
  const parent = store.append({
    ...base,
    catId: 'codex-astra',
    mentions: ['opus5'],
    content: '@opus5 请读原文',
    timestamp: 2,
  });
  const reply = store.append({ ...base, catId: 'opus5', replyTo: parent.id, content: '真实结果', timestamp: 3 });
  const factory = createProviderNativeFreshnessFactory({
    redis: { multi: () => transaction },
    cursorStore: cursors,
    messageStore: store,
    threadStore: { get: async () => ({ thinkingMode: 'debug' }) },
  });
  const input = {
    invocationId: 'live',
    threadId: 'home',
    userId: 'owner',
    catId: 'codex-astra',
    provider: 'openai',
    capability: { provider: 'openai_codex', carrier: 'codex_app_server', deliverySemantics: 'exact_active_turn' },
    liveExposureReason: () => null,
  };
  const ordinary = await factory(input);
  assert.equal(await ordinary.idle.prepare(), null, 'exposure filtering alone is not result-return authority');
  let active = false;
  const live = await factory({ ...input, liveResultConsumerActive: () => active });
  assert.equal(await live.idle.prepare(), null, 'not-ready, stopped or voice-only consumers must remain quiet');
  active = true;
  const notice = await live.idle.prepare();
  assert.ok(notice);
  assert.deepEqual(notice.correlationMessageIds, [reply.id], 'only the actual reply, never its own parent');
  await live.idle.commitDelivered(notice, { acceptedTurnId: 'accepted-native-turn' });
  await cursors.ackSeenCursor('owner', 'codex-astra', 'home', cursorFor(reply));
  assert.equal(await live.idle.prepare(), null, 'full read suppresses the repeat');
  const outside = store.append({ ...base, catId: 'codex-sol', content: '另一条来信', timestamp: 4 });
  assert.deepEqual((await ordinary.idle.prepare()).correlationMessageIds, [outside.id]);
  active = false;
  assert.equal(await live.idle.prepare(), null, 'consumer revocation is checked on each boundary');
  assert.equal(
    events.some((event) => event.kind.includes('handled')),
    false,
    'attention does not complete dispatch work',
  );
});
