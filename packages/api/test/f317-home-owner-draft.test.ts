import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { appendHomeOwnerDraft } from '../src/domains/concierge/live/host/home/home-owner-draft.js';

function fixture() {
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = threads.create('owner', '/project');
  const input = {
    messages,
    threads,
    ownerUserId: 'owner',
    threadId: thread.id,
    expectedRevision: 0,
    literal: '今晚记得带伞',
    isCurrent: async () => true,
    signal: new AbortController().signal,
  };
  return { messages, threads, thread, input };
}

test('insertion preserves original text, image, quote and reply in the canonical persistent composer owner', async () => {
  const f = fixture();
  const blocks = [{ type: 'image' as const, url: '/uploads/kept.png' }];
  f.messages.putOwnerComposerDraft('owner', f.thread.id, {
    expectedRevision: 0,
    text: '原有草稿',
    contentBlocks: blocks,
    replyTo: 'original-message',
    updatedAt: Date.now(),
  });
  const result = await appendHomeOwnerDraft({ ...f.input, expectedRevision: 1 });
  assert.equal(result.kind, 'updated');
  const draft = f.messages.getOwnerComposerDraft('owner', f.thread.id);
  assert.equal(draft?.text, '原有草稿\n今晚记得带伞');
  assert.deepEqual(draft?.contentBlocks, blocks);
  assert.equal(draft?.replyTo, 'original-message');
  assert.equal(draft?.revision, 2);
  assert.deepEqual(f.messages.getByThread(f.thread.id), [], 'draft insertion never posts a message');
});

test('a concurrent owner draft revision is not overwritten or retried', async () => {
  const f = fixture();
  const result = await appendHomeOwnerDraft({
    ...f.input,
    isCurrent: async () => {
      f.messages.putOwnerComposerDraft('owner', f.thread.id, {
        expectedRevision: 0,
        text: '新并发输入',
        updatedAt: Date.now(),
      });
      return true;
    },
  });
  assert.equal(result.kind, 'conflict');
  assert.equal(f.messages.getOwnerComposerDraft('owner', f.thread.id)?.text, '新并发输入');
});

test('foreign or deleted targets and revoked source eligibility produce no durable mutation', async () => {
  const f = fixture();
  const foreign = f.threads.create('other-owner', '/project');
  assert.equal((await appendHomeOwnerDraft({ ...f.input, threadId: foreign.id })).kind, 'blocked');
  assert.equal((await appendHomeOwnerDraft({ ...f.input, isCurrent: async () => false })).kind, 'stale');
  assert.equal((await appendHomeOwnerDraft({ ...f.input, signal: AbortSignal.abort() })).kind, 'blocked');
  assert.equal(f.messages.getOwnerComposerDraft('owner', f.thread.id), null);
  assert.equal(f.messages.getOwnerComposerDraft('owner', foreign.id), null);
});
