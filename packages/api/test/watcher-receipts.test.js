import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDirectWatcherControl } from '../dist/domains/concierge/watcher/watcher-controls.js';
import { createWatcherReceipts } from '../dist/domains/concierge/watcher/watcher-receipts.js';
import { createSuggestionIntegration } from '../dist/domains/suggestions/composition.js';
import { watcherWorld } from './helpers/watcher-world.js';

async function setup(content = '这两小时别烦我') {
  const w = await watcherWorld();
  const message = await w.messages.append({
    userId: 'watcher-owner',
    threadId: w.thread.id,
    from: { kind: 'user', userId: 'watcher-owner' },
    content,
    timestamp: 100,
    mentions: [],
  });
  const suggestions = createSuggestionIntegration({ messageStore: w.messages });
  const receipts = createWatcherReceipts({ ...w, ...suggestions, changed() {} });
  const changed = await applyDirectWatcherControl(
    w.threads,
    { role: 'user', threadId: w.thread.id, messageId: message.id, content },
    100,
  );
  const row = await receipts.control({
    userId: 'watcher-owner',
    threadId: w.thread.id,
    catId: 'codex',
    messageId: message.id,
    ...changed,
  });
  assert.equal(row.ok, true, JSON.stringify(row));
  return { ...w, suggestions, receipts, message, row: row.value };
}

test('a direct pause is effective before its shared receipt, with one watcher row and the original resume action', async () => {
  const f = await setup();
  assert.equal((await f.threads.get(f.thread.id)).watcher.pausedUntil, 7_200_100);
  assert.equal(f.row.messageId, f.message.id);
  assert.equal(f.row.byline, 'watcher');
  assert.equal(f.row.undo, 'resume');
  const result = await f.suggestions.service.undo('watcher-owner', f.row.id, f.row.revision);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await f.threads.get(f.thread.id)).watcher.pausedUntil, undefined);
});

test('a close receipt resumes the original thread only, and an old undo cannot replace a newer setting', async () => {
  const f = await setup('这条别守望了');
  assert.equal(f.row.receipt.text, '已关闭');
  const current = (await f.threads.get(f.thread.id)).watcher;
  await f.threads.updateWatcherControl(f.thread.id, current.revision, { pausedUntil: 999999 });
  const result = await f.suggestions.service.undo('watcher-owner', f.row.id, f.row.revision);
  assert.equal(result.ok, false);
  assert.equal((await f.threads.get(f.thread.id)).watcher.enabled, false);
  assert.equal((await f.threads.get(f.thread.id)).watcher.pausedUntil, 999999);
});

test('replaying the same human command does not extend the pause or overwrite a later manual setting', async () => {
  const f = await setup();
  const source = { role: 'user', content: '这两小时别烦我', threadId: f.thread.id, messageId: f.message.id };
  await applyDirectWatcherControl(f.threads, source, 100);
  assert.equal((await f.threads.get(f.thread.id)).watcher.revision, 1);
  await f.threads.updateWatcherControl(f.thread.id, 1, { enabled: false });
  assert.equal(await applyDirectWatcherControl(f.threads, source, 100), null);
  assert.equal((await f.threads.get(f.thread.id)).watcher.enabled, false);
});
