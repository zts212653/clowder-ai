// F317 north-star regression harness: direct typed input vs page-action source authority.
// Typed Live sources carry the current call/user/client-message binding. sendText records
// noteAcceptedDirectRequest after accepted native delivery. Voice metadata alone grants nothing:
// only the Host-owned call can also supply its exact committed same-call exposure receipt.
// This isolated authority deliberately has no voice-exposure verifier.
// No media, no visible cat; fake page port only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import {
  LivePageActionAuthority,
  type TrustedPageActionApproval,
} from '../src/domains/concierge/live/host/page-action/live-page-action-authority.js';
import { directOwner } from '../src/domains/concierge/live/host/page-action/live-page-action-authority-contract.js';
import { persistLiveTranscriptItem, persistLiveUserText } from '../src/domains/concierge/live/live-transcript.js';
import { fixture, scope } from './helpers/f317-page-action-fixture.js';

const binding = { userId: scope.userId, threadId: scope.threadId, callId: scope.callId };

function authorityOver(store: MessageStore, f: ReturnType<typeof fixture>) {
  return new LivePageActionAuthority({
    currentScope: () => scope,
    messages: store,
    isCurrentThread: async (userId, threadId) => userId === scope.userId && threadId === scope.threadId,
    verifyCompanion: async () => true,
    verifyApproval: async () => true,
    run: (operation) => operation(),
  });
}
const approval = (f: ReturnType<typeof fixture>): TrustedPageActionApproval => f.approval;

test('text the owner typed into the Live call satisfies the direct-owner predicate', async () => {
  const store = new MessageStore();
  const typed = await persistLiveUserText(store, binding, 'Fill the approved note', 'client-1');
  assert.equal(directOwner(typed.message, scope), true, 'typed Live text is the owner speaking directly');
  assert.equal(
    directOwner(typed.message, { ...scope, callId: 'foreign-call' }),
    false,
    'typed sources remain bound to their own call',
  );
  assert.equal(
    directOwner(
      { ...typed.message, extra: { liveCompanion: { ...typed.message.extra!.liveCompanion!, role: 'assistant' } } },
      scope,
    ),
    false,
  );
});

test('a page action can be staged from a request the owner typed into the Live call', async () => {
  const f = fixture();
  const store = new MessageStore();
  const typed = await persistLiveUserText(store, binding, 'Fill the approved note', 'client-1');
  const authorityId = await authorityOver(store, f).stage({
    requestMessageId: typed.message.id,
    approval: approval(f),
    port: f.port,
  });
  assert.match(authorityId, /^[0-9a-f-]{36}$/);
});

test('spoken segments without the same-call Host exposure receipt cannot be direct owner requests', async () => {
  const f = fixture();
  const store = new MessageStore();
  const spoken = await persistLiveTranscriptItem(
    store,
    { ...binding, catId: createCatId('codex-astra'), nativeThreadId: 'native', realtimeSessionId: 'rtc' },
    {
      method: 'thread/realtime/item/completed',
      params: {
        threadId: 'native',
        item: {
          id: 'u1',
          role: 'user',
          text: 'Fill the approved note',
          type: 'transcriptSegment',
          realtimeSessionId: 'rtc',
        },
      },
    },
  );
  assert.ok(spoken);
  assert.equal(directOwner(spoken, scope), false);
  await assert.rejects(
    authorityOver(store, f).stage({ requestMessageId: spoken.id, approval: approval(f), port: f.port }),
  );
});
