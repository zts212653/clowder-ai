// F317 north-star regression harness, cross-line guard (A typed source vs F page-action authority).
// The page-action authority accepts a request source only if directOwner(message) holds, and directOwner
// requires "no extra.liveCompanion". Text the owner types into a Live call is written by persistLiveUserText,
// and LiveCompanionCall.sendText notes its id (noteAcceptedDirectText) as the fresh direct request after an
// interruption. If the typed writer starts stamping extra.liveCompanion, that request stops qualifying.
// Only functions that exist before and after the candidate are used, so the same file runs on a control tree.
// No media, no visible cat; fake page port only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import {
  LivePageActionAuthority,
  type TrustedPageActionApproval,
} from '../src/domains/concierge/live/host/live-page-action-authority.js';
import { directOwner } from '../src/domains/concierge/live/host/live-page-action-authority-contract.js';
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

test('spoken segments are never a direct owner request, whatever role they carry', async () => {
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
