import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { createCodexSessionContextSnapshotResolver } = await import(
  '../dist/domains/cats/services/agents/providers/codex-session-context-snapshot.js'
);

test('returns null when rollout file for session does not exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
  try {
    const resolveSnapshot = createCodexSessionContextSnapshotResolver({
      sessionsRoot: root,
    });
    const snapshot = await resolveSnapshot('missing-session');
    assert.equal(snapshot, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prefers latest token_count with non-zero rate usage when duplicates exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
  const sessionId = '019c5eaf-fa08-73b1-89bb-1e3d5939c9d3';
  const dayDir = join(root, '2026', '02', '14');
  await mkdir(dayDir, { recursive: true });
  const file = join(dayDir, `rollout-2026-02-14T16-25-17-${sessionId}.jsonl`);

  const baseInfo = {
    total_token_usage: {
      input_tokens: 529593,
      cached_input_tokens: 405760,
      output_tokens: 10298,
    },
    last_token_usage: {
      input_tokens: 186749,
      cached_input_tokens: 165120,
      output_tokens: 1011,
    },
    model_context_window: 258400,
  };

  const lines = [
    JSON.stringify({
      timestamp: '2026-02-14T22:30:35.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: baseInfo,
        rate_limits: {
          primary: { used_percent: 0, resets_at: 1771126226 },
          secondary: { used_percent: 44, resets_at: 1771482198 },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-02-14T22:30:36.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: baseInfo,
        rate_limits: {
          primary: { used_percent: 0, resets_at: 1771134743 },
          secondary: { used_percent: 0, resets_at: 1771721543 },
        },
      },
    }),
  ];
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

  try {
    const resolveSnapshot = createCodexSessionContextSnapshotResolver({
      sessionsRoot: root,
      tailBytes: 16 * 1024,
    });

    const snapshot = await resolveSnapshot(sessionId);
    assert.ok(snapshot, 'snapshot should be found');
    assert.equal(snapshot.contextUsedTokens, 186749);
    assert.equal(snapshot.contextWindowTokens, 258400);
    assert.equal(snapshot.lastCachedInputTokens, 165120);
    assert.equal(snapshot.lastOutputTokens, 1011);
    assert.equal(snapshot.totalInputTokens, 529593);
    assert.equal(snapshot.totalCachedInputTokens, 405760);
    assert.equal(snapshot.totalOutputTokens, 10298);
    // Must pick the non-zero-rate event reset value (1771482198s).
    assert.equal(snapshot.contextResetsAtMs, 1771482198 * 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('caps internal session file cache with LRU eviction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
  const cache = new Map();
  const dayDir = join(root, '2026', '02', '14');
  await mkdir(dayDir, { recursive: true });

  const sessionIds = ['sid-1-aaaaaaaaaaaaaaaaaaaa', 'sid-2-bbbbbbbbbbbbbbbbbbbb', 'sid-3-cccccccccccccccccccc'];

  for (const sessionId of sessionIds) {
    const file = join(dayDir, `rollout-2026-02-14T16-25-17-${sessionId}.jsonl`);
    const row = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 1000 },
          model_context_window: 258400,
        },
        rate_limits: {
          primary: { used_percent: 1, resets_at: 1771126226 },
          secondary: { used_percent: 0, resets_at: 1771721543 },
        },
      },
    });
    await writeFile(file, `${row}\n`, 'utf8');
  }

  try {
    const resolveSnapshot = createCodexSessionContextSnapshotResolver({
      sessionsRoot: root,
      tailBytes: 16 * 1024,
      fileCache: cache,
      maxCacheEntries: 2,
    });

    await resolveSnapshot(sessionIds[0]);
    await resolveSnapshot(sessionIds[1]);
    await resolveSnapshot(sessionIds[2]);

    assert.equal(cache.size, 2, 'cache size should be capped');
    assert.equal(cache.has(sessionIds[0]), false, 'oldest entry should be evicted');
    assert.equal(cache.has(sessionIds[1]), true);
    assert.equal(cache.has(sessionIds[2]), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
