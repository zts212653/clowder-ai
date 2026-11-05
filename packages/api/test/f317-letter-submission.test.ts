import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { companionTextDigest } from '../src/domains/cats/services/stores/companion-submission-state.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { CompanionBridgeError } from '../src/domains/concierge/live/companion-owner-client.js';
import { CompanionSubmissionDelivery } from '../src/domains/concierge/live/host/companion-submission-delivery.js';

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object');
  return value as Record<string, unknown>;
}
function fixture() {
  const messages = new MessageStore();
  let threadId = 'home';
  let callId: string | undefined;
  let requests = 0;
  let executions = 0;
  let loseReceipt = false;
  let afterAccepted: (() => void) | undefined;
  const client = {
    async request(path: string, _method?: string, payload?: object): Promise<Record<string, unknown>> {
      requests++;
      const body = object(payload);
      const key =
        path === '/api/messages' ? String(body.idempotencyKey) : `live-text:${callId}:${body.clientMessageId}`;
      const text = String(body.content ?? body.text);
      const stored = messages.appendIdempotent({
        userId: 'owner',
        threadId,
        from: { kind: 'user', userId: 'owner' },
        content: text,
        mentions: [],
        timestamp: Date.now(),
        idempotencyKey: key,
        ...(path === '/api/messages'
          ? {}
          : {
              extra: {
                liveCompanion: {
                  modality: 'typed' as const,
                  role: 'user' as const,
                  callId: callId!,
                  clientMessageId: String(body.clientMessageId),
                },
              },
            }),
      });
      if (!stored.idempotent) executions++;
      if (path !== '/api/messages')
        messages.recordCompanionDeliveryAcceptance(stored.message.id, {
          ownerUserId: 'owner',
          threadId,
          clientMessageId: String(body.clientMessageId),
          callId: callId!,
          contentDigest: companionTextDigest(text),
          acceptedAt: Date.now(),
        });
      afterAccepted?.();
      if (loseReceipt) {
        loseReceipt = false;
        throw new CompanionBridgeError('unavailable');
      }
      return path === '/api/messages'
        ? { status: stored.idempotent ? 'duplicate' : 'queued', userMessageId: stored.message.id }
        : { delivery: 'accepted', messageId: stored.message.id };
    },
  };
  const options = {
    ownerUserId: 'owner',
    client,
    messages,
    conversationThread: async () => threadId,
    verifyThread: async (candidate: string) => candidate === threadId,
    currentCallId: () => callId,
    assertCurrent: async () => {},
  };
  const manager = () => new CompanionSubmissionDelivery(options);
  return {
    messages,
    manager,
    setCall(value?: string) {
      callId = value;
    },
    changeThread() {
      threadId = 'new-home';
    },
    lose() {
      loseReceipt = true;
    },
    onAccepted(action: () => void) {
      afterAccepted = action;
    },
    count: () => ({ requests, executions }),
  };
}
async function draft(manager: CompanionSubmissionDelivery, text: string) {
  const initial = object(await manager.readDraft());
  return object(await manager.saveDraft(String(initial.scopeRef), Number(initial.revision), text));
}

test('lost receipt across Host rebuild and call change retries the original plain admission exactly once', async () => {
  const f = fixture();
  const first = f.manager();
  const saved = await draft(first, 'Input A');
  const input = {
    scopeRef: String(saved.scopeRef),
    text: 'Input A',
    clientMessageId: randomUUID(),
    submissionRevision: Number(saved.revision),
  };
  f.lose();
  assert.equal(object(await first.submit(input)).delivery, 'unconfirmed');
  f.setCall(randomUUID());
  const rebuilt = f.manager();
  const recovered = object(await rebuilt.readDraft());
  assert.equal((recovered.submissions as unknown[]).length, 1);
  const accepted = object(await rebuilt.submit(input));
  assert.equal(accepted.delivery, 'accepted');
  assert.equal(accepted.callId, null, 'the retry may not borrow the new live call');
  assert.equal(f.count().executions, 1);
  assert.equal(object(await rebuilt.readDelivery(input.scopeRef, input.clientMessageId)).messageId, accepted.messageId);
});

test('native acceptance is recovered from its persisted Host fact after the original call is gone', async () => {
  const f = fixture();
  const callId = randomUUID();
  f.setCall(callId);
  const manager = f.manager();
  const saved = await draft(manager, 'Live input');
  const input = {
    scopeRef: String(saved.scopeRef),
    text: 'Live input',
    clientMessageId: randomUUID(),
    submissionRevision: Number(saved.revision),
  };
  f.lose();
  assert.equal(object(await manager.submit(input)).delivery, 'unconfirmed');
  f.setCall(undefined);
  const rebuilt = f.manager();
  assert.equal(object(await rebuilt.readDelivery(input.scopeRef, input.clientMessageId)).delivery, 'accepted');
  assert.equal(object(await rebuilt.submit(input)).delivery, 'accepted');
  assert.deepEqual(f.count(), { requests: 1, executions: 1 });
});

test('accepted input and clearing an unchanged draft are independent; newer text survives', async () => {
  const f = fixture();
  const manager = f.manager();
  const saved = await draft(manager, 'Input A');
  f.onAccepted(() => {
    const current = f.messages.getOwnerComposerDraft('owner', 'home')!;
    f.messages.putOwnerComposerDraft('owner', 'home', {
      expectedRevision: current.revision,
      text: 'Newer B',
      updatedAt: Date.now(),
    });
  });
  assert.equal(
    object(
      await manager.submit({
        scopeRef: String(saved.scopeRef),
        text: 'Input A',
        clientMessageId: randomUUID(),
        submissionRevision: Number(saved.revision),
      }),
    ).delivery,
    'accepted',
  );
  assert.equal(f.messages.getOwnerComposerDraft('owner', 'home')?.text, 'Newer B');
});

test('a stale scope cannot submit into a newly created canonical conversation; rich drafts remain intact', async () => {
  const f = fixture();
  const manager = f.manager();
  const saved = await draft(manager, 'Input A');
  f.changeThread();
  await assert.rejects(
    manager.submit({
      scopeRef: String(saved.scopeRef),
      text: 'Input A',
      clientMessageId: randomUUID(),
      submissionRevision: Number(saved.revision),
    }),
    /invalid_request/,
  );
  assert.equal(f.count().executions, 0);
  const empty = object(await manager.readDraft());
  assert.notEqual(empty.scopeRef, saved.scopeRef, 'the existing Host adopts the current canonical thread');
  assert.equal(empty.text, '');
  f.messages.putOwnerComposerDraft('owner', 'new-home', {
    expectedRevision: 0,
    text: 'Rich source',
    replyTo: 'parent',
    updatedAt: Date.now(),
  });
  assert.deepEqual(await manager.saveDraft(String(empty.scopeRef), 0, 'Replacement'), {
    kind: 'conversation-draft',
    v: 1,
    status: 'readonly',
    revision: 1,
  });
  assert.equal(f.messages.getOwnerComposerDraft('owner', 'new-home')?.text, 'Rich source');
});

test('recovery returns one accepted receipt and every unresolved intent without deleting source facts', async () => {
  const f = fixture();
  const manager = f.manager();
  const inputs = [];
  for (const text of ['Input A', 'Input B']) {
    const saved = await draft(manager, text);
    const input = {
      scopeRef: String(saved.scopeRef),
      text,
      clientMessageId: randomUUID(),
      submissionRevision: Number(saved.revision),
    };
    f.lose();
    assert.equal(object(await manager.submit(input)).delivery, 'unconfirmed');
    inputs.push(input);
  }
  for (const input of inputs) {
    const original = f.messages.getByIdempotencyKey('owner', 'home', input.clientMessageId)!;
    f.messages.recordCompanionDeliveryAcceptance(original.id, {
      ownerUserId: 'owner',
      threadId: 'home',
      clientMessageId: input.clientMessageId,
      callId: null,
      contentDigest: companionTextDigest(input.text),
      acceptedAt: Date.now(),
    });
  }
  const saved = await draft(manager, 'Still unresolved');
  const unresolved = {
    scopeRef: String(saved.scopeRef),
    text: 'Still unresolved',
    clientMessageId: randomUUID(),
    submissionRevision: Number(saved.revision),
  };
  // Stage an unresolved receipt beside the two already persisted acceptance facts.
  const stored = f.messages.getOwnerComposerDraft('owner', 'home')!;
  f.messages.putOwnerComposerDraft('owner', 'home', {
    expectedRevision: stored.revision,
    text: stored.text,
    updatedAt: Date.now(),
    companionSubmissions: [
      ...stored.companionSubmissions!,
      {
        clientMessageId: unresolved.clientMessageId,
        text: unresolved.text,
        submissionRevision: unresolved.submissionRevision,
        callId: null,
        reservationRevision: stored.revision + 1,
        createdAt: Date.now(),
      },
    ],
  });
  const recovered = object(await f.manager().readDraft()).submissions as Record<string, unknown>[];
  assert.equal(recovered.filter((row) => object(row.receipt).delivery === 'accepted').length, 1);
  assert.equal(
    recovered.some((row) => row.clientMessageId === unresolved.clientMessageId),
    true,
  );
  assert.equal(f.messages.getOwnerComposerDraft('owner', 'home')?.companionSubmissions?.length, 3);
  for (const input of inputs)
    assert.equal(object(await manager.readDelivery(input.scopeRef, input.clientMessageId)).delivery, 'accepted');
});

test('read preserves oversized canonical text and a full pending set rejects deterministically without sending', async () => {
  const f = fixture();
  const manager = f.manager();
  f.messages.putOwnerComposerDraft('owner', 'home', { expectedRevision: 0, text: 'x'.repeat(100000), updatedAt: 100 });
  const full = object(await manager.readDraft());
  assert.equal(String(full.text).length, 100000);
  assert.equal(full.writable, false);
  assert.deepEqual(await manager.saveDraft(String(full.scopeRef), Number(full.revision), 'short'), {
    kind: 'conversation-draft',
    v: 1,
    status: 'readonly',
    revision: 1,
  });
  f.messages.putOwnerComposerDraft('owner', 'home', {
    expectedRevision: 1,
    text: 'New input',
    updatedAt: 101,
    companionSubmissions: Array.from({ length: 32 }, () => ({
      clientMessageId: randomUUID(),
      text: 'Unconfirmed',
      callId: null,
      submissionRevision: 0,
      reservationRevision: 1,
      createdAt: 100,
    })),
  });
  const clientMessageId = randomUUID();
  const input = { scopeRef: String(full.scopeRef), text: 'New input', clientMessageId, submissionRevision: 2 };
  assert.deepEqual(await manager.submit(input), {
    kind: 'delivery',
    v: 2,
    delivery: 'rejected',
    reason: 'pending_limit',
    draftRevision: 2,
    clientMessageId,
  });
  assert.deepEqual(f.count(), { requests: 0, executions: 0 });
  assert.equal(f.messages.getOwnerComposerDraft('owner', 'home')?.companionSubmissions?.length, 32);
});

test('concurrent same-intent retries accept one source and reject a changed immutable tuple', async () => {
  const f = fixture();
  const saved = await draft(f.manager(), 'Input');
  const input = {
    scopeRef: String(saved.scopeRef),
    text: 'Input',
    clientMessageId: randomUUID(),
    submissionRevision: Number(saved.revision),
  };
  const pair = await Promise.all([f.manager().submit(input), f.manager().submit(input)]);
  assert.equal(object(pair[0]).delivery, 'accepted');
  assert.equal(object(pair[1]).messageId, object(pair[0]).messageId);
  assert.equal(f.count().executions, 1);
  await assert.rejects(f.manager().submit({ ...input, text: 'Altered' }), /invalid_request/);
  await assert.rejects(
    f.manager().submit({ ...input, submissionRevision: input.submissionRevision + 1 }),
    /invalid_request/,
  );
});
