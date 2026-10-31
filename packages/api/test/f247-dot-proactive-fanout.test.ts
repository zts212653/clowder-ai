import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';
import { dotProactiveFixture as fixture } from './helpers/f247-dot-proactive-fixture.js';

for (const failure of ['depth limit', 'atomic admission exception'] as const) {
  test(`complete dot fan-out remains retryable after ${failure}`, async () => {
    const f = await fixture();
    let blocked = true;
    const send = f.queue.send.bind(f.queue);
    if (failure === 'atomic admission exception')
      f.queue.send = (...args) => {
        if (blocked) throw new Error('atomic admission unavailable');
        return send(...args);
      };
    try {
      const thread = f.thread(failure);
      const fillers: string[] = [];
      if (failure === 'depth limit')
        for (let i = 0; i < 10; i++) {
          const result = f.queue.enqueueDurableNow({
            threadId: thread.id,
            userId: 'owner',
            ownerAuthProvenance: 'unknown',
            content: `other question ${i}`,
            from: { kind: 'agent', catId: 'codex' },
            sourceId: `filler:${i}`,
            kind: 'message_wake',
            messageId: `filler:${i}`,
            targetCats: ['codex'],
            intent: 'execute',
          });
          assert.ok(result.entry);
          fillers.push(result.entry.id);
        }
      const ask = () =>
        f.rpc({
          attempt_id: f.setup.attemptId,
          thread_id: thread.id,
          target_cat_ids: ['codex', 'sonnet'],
          content: '请两只猫分别回答',
          client_message_id: 'same-question',
        });
      for (let retry = 0; retry < 2; retry++) {
        const result = await ask();
        assert.equal(result.error?.data.reason, 'dot_ask_delivery_pending', JSON.stringify(result));
        assert.equal(
          f.queue.list(thread.id, 'owner').filter((e) => e.from.kind === 'agent' && e.from.catId === 'gpt-dot').length,
          0,
        );
        assert.equal(
          f.messages.getByThread(thread.id, undefined, 'owner', { includeQueuedCatMessages: true }).length,
          0,
          'failed atomic admission does not publish a partial source',
        );
      }
      blocked = false;
      if (failure === 'depth limit') await f.queue.terminalizeEntryDurable(thread.id, 'owner', fillers[0]);
      const recovered = await ask();
      assert.ok(recovered.result, JSON.stringify(recovered));
      const rootId = recovered.result.structuredContent.messageId;
      const entries = f.queue
        .list(thread.id, 'owner')
        .filter((e) => e.from.kind === 'agent' && e.from.catId === 'gpt-dot');
      assert.equal(entries.length, 1, 'one source owns one durable row for its complete target set');
      assert.deepEqual(entries[0].targets, ['codex', 'sonnet']);
      assert.equal(entries[0].payload.messageId, rootId);
      assert.equal((await ask()).result.structuredContent.messageId, rootId);
      assert.equal(
        f.queue.list(thread.id, 'owner').filter((e) => e.from.kind === 'agent' && e.from.catId === 'gpt-dot').length,
        1,
      );
    } finally {
      await f.close();
    }
  });
}

test('distinct questions keep distinct complete fan-out rows while each retry is idempotent', async () => {
  const f = await fixture();
  try {
    const thread = f.thread('coalesced questions');
    const ask = (key: string) =>
      f.rpc({
        attempt_id: f.setup.attemptId,
        thread_id: thread.id,
        target_cat_ids: ['codex', 'sonnet'],
        content: `请两只猫分别回答 ${key}`,
        client_message_id: key,
      });
    const first = await ask('first');
    const second = await ask('second');
    assert.ok(first.result && second.result, JSON.stringify([first, second]));
    assert.notEqual(first.result.structuredContent.messageId, second.result.structuredContent.messageId);
    assert.deepEqual(second.result.structuredContent.routed, ['codex', 'sonnet']);
    assert.equal((await ask('second')).result.structuredContent.messageId, second.result.structuredContent.messageId);
    const children = f.queue.list(thread.id, 'owner');
    assert.equal(children.length, 2);
    assert.deepEqual(
      children.map((entry) => entry.payload.messageId).sort(),
      [first.result.structuredContent.messageId, second.result.structuredContent.messageId].sort(),
    );
    assert.ok(children.every((entry) => entry.targets.join(',') === 'codex,sonnet'));
  } finally {
    await f.close();
  }
});

test('accepted rich question replays persisted media after the local source disappears', async () => {
  const f = await fixture();
  const mediaRoot = await mkdtemp(join(tmpdir(), 'dot-accepted-gallery-'));
  registerWorktrees([{ id: 'dot-accepted-gallery', root: mediaRoot, branch: 'test', head: 'test' }]);
  const image = join(mediaRoot, 'image.png');
  await writeFile(image, 'image');
  try {
    const thread = f.thread('media replay');
    const content =
      '请回答\n```cc_rich\n' +
      JSON.stringify({ v: 1, blocks: [{ id: 'dot-image', kind: 'media_gallery', v: 1, items: [{ url: image }] }] }) +
      '\n```';
    const first = await f.ask(thread.id, 'media-key', content);
    assert.ok(first.result, JSON.stringify(first));
    const rootId = first.result.structuredContent.messageId;
    const root = f.messages.getById(rootId)!;
    assert.ok(root.extra?.rich?.blocks.length);
    assert.ok(root.extra?.dotAsk?.requestDigest);
    await unlink(image);
    const replay = await f.ask(thread.id, 'media-key', content);
    assert.equal(replay.result?.structuredContent.messageId, rootId, JSON.stringify(replay));
    assert.deepEqual(f.messages.getById(rootId)?.extra?.rich, root.extra?.rich);
    assert.equal(f.queue.list(thread.id, 'owner').length, 1);
  } finally {
    await f.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});
