import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import {
  applyDirectWatcherControl,
  effectiveWatcherState,
  parseWatcherControlIntent,
} from '../dist/domains/concierge/watcher/watcher-controls.js';

test('only direct human control commands alter the selected thread', async () => {
  const threads = new ThreadStore();
  const thread = await threads.create('owner');
  for (const text of ['“这两小时别烦我”', '> 这条别守望了', '比如说这两小时别烦我', '```这条别守望了```'])
    assert.equal(parseWatcherControlIntent(text, 100), null);
  assert.equal(
    await applyDirectWatcherControl(threads, { role: 'assistant', content: '这条别守望了', threadId: thread.id }, 100),
    null,
  );
  const paused = await applyDirectWatcherControl(
    threads,
    { role: 'user', content: '这两小时别烦我', threadId: thread.id },
    100,
  );
  assert.equal(paused.current.pausedUntil, 7_200_100);
  assert.equal(
    (await applyDirectWatcherControl(threads, { role: 'user', content: '这条别守望了。', threadId: thread.id }, 200))
      .current.enabled,
    false,
  );
});

test('pause and label quiet keep viewing; global or thread off stops viewing', () => {
  const config = { revision: 0, scope: 'all', enabled: true, memberCatId: 'codex61-sol' };
  assert.deepEqual(effectiveWatcherState(config, { watcher: { revision: 1, pausedUntil: 1000 } }, [], 500), {
    enabled: true,
    maySpeak: false,
    pausedUntil: 1000,
    labelMuted: false,
  });
  assert.equal(effectiveWatcherState(config, { labels: ['private'] }, ['private'], 2000).maySpeak, false);
  assert.equal(effectiveWatcherState(config, { watcher: { revision: 2, enabled: false } }, [], 2000).enabled, false);
  assert.equal(
    effectiveWatcherState({ ...config, enabled: false }, { watcher: { revision: 1, enabled: true } }, [], 2000).enabled,
    false,
  );
});
