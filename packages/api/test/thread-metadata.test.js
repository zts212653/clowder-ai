/**
 * #872: Thread Metadata MCP Tests
 *
 * Tests for ThreadMetadataV1 type, merge semantics, in-memory store,
 * and parseThreadMetadataJson fail-open behavior.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('ThreadMetadataV1 merge semantics', () => {
  test('mergeThreadMetadata — empty patch on undefined returns v:1 skeleton', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const result = mergeThreadMetadata(undefined, {});
    assert.deepEqual(result, { v: 1 });
  });

  test('mergeThreadMetadata — append worktrees with dedupe', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, worktrees: ['/path/a'] };
    const result = mergeThreadMetadata(existing, {
      worktrees: ['/path/a', '/path/b'],
    });
    assert.deepEqual(result.worktrees, ['/path/a', '/path/b']);
  });

  test('mergeThreadMetadata — removeWorktrees removes items', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, worktrees: ['/path/a', '/path/b'] };
    const result = mergeThreadMetadata(existing, {
      removeWorktrees: ['/path/a'],
    });
    assert.deepEqual(result.worktrees, ['/path/b']);
  });

  test('mergeThreadMetadata — worktrees set to undefined when all removed', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, worktrees: ['/path/a'] };
    const result = mergeThreadMetadata(existing, {
      removeWorktrees: ['/path/a'],
    });
    assert.equal(result.worktrees, undefined);
  });

  test('mergeThreadMetadata — append PRs with dedupe by repo#number (case insensitive)', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = {
      v: 1,
      prs: [{ repo: 'owner/repo', number: 1 }],
    };
    const result = mergeThreadMetadata(existing, {
      prs: [
        { repo: 'Owner/Repo', number: 1 }, // duplicate (case-insensitive)
        { repo: 'owner/repo', number: 2 }, // new
      ],
    });
    assert.equal(result.prs?.length, 2);
    assert.deepEqual(result.prs?.[0], { repo: 'owner/repo', number: 1 });
    assert.deepEqual(result.prs?.[1], { repo: 'owner/repo', number: 2 });
  });

  test('mergeThreadMetadata — removePrs removes by key', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = {
      v: 1,
      prs: [
        { repo: 'owner/repo', number: 1 },
        { repo: 'owner/repo', number: 2 },
      ],
    };
    const result = mergeThreadMetadata(existing, {
      removePrs: [{ repo: 'Owner/Repo', number: 1 }],
    });
    assert.equal(result.prs?.length, 1);
    assert.deepEqual(result.prs?.[0], { repo: 'owner/repo', number: 2 });
  });

  test('mergeThreadMetadata — append issues with dedupe', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const result = mergeThreadMetadata(undefined, {
      issues: [
        { repo: 'zts212653/clowder-ai', number: 872 },
        { repo: 'zts212653/clowder-ai', number: 872 }, // dup
      ],
    });
    assert.equal(result.issues?.length, 1);
    assert.deepEqual(result.issues?.[0], {
      repo: 'zts212653/clowder-ai',
      number: 872,
    });
  });

  test('mergeThreadMetadata — append features with dedupe', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, features: ['F001'] };
    const result = mergeThreadMetadata(existing, {
      features: ['F001', 'F002'],
    });
    assert.deepEqual(result.features, ['F001', 'F002']);
  });

  test('mergeThreadMetadata — removeFeatures removes items', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, features: ['F001', 'F002'] };
    const result = mergeThreadMetadata(existing, {
      removeFeatures: ['F001'],
    });
    assert.deepEqual(result.features, ['F002']);
  });

  test('mergeThreadMetadata — notes merge: string sets, null deletes', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = {
      v: 1,
      notes: { key1: 'value1', key2: 'value2' },
    };
    const result = mergeThreadMetadata(existing, {
      notes: { key1: null, key3: 'value3' },
    });
    assert.deepEqual(result.notes, { key2: 'value2', key3: 'value3' });
  });

  test('mergeThreadMetadata — notes set to undefined when all deleted', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = { v: 1, notes: { key1: 'value1' } };
    const result = mergeThreadMetadata(existing, {
      notes: { key1: null },
    });
    assert.equal(result.notes, undefined);
  });

  test('mergeThreadMetadata — does not mutate existing object', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = {
      v: 1,
      worktrees: ['/path/a'],
      notes: { k: 'v' },
    };
    const snapshot = JSON.stringify(existing);
    mergeThreadMetadata(existing, {
      worktrees: ['/path/b'],
      notes: { k: null },
    });
    assert.equal(JSON.stringify(existing), snapshot);
  });

  test('mergeThreadMetadata — combined add and remove in single call', async () => {
    const { mergeThreadMetadata } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const existing = {
      v: 1,
      worktrees: ['/old'],
      prs: [{ repo: 'a/b', number: 1 }],
      features: ['F001'],
    };
    const result = mergeThreadMetadata(existing, {
      worktrees: ['/new'],
      removeWorktrees: ['/old'],
      prs: [{ repo: 'c/d', number: 2 }],
      removePrs: [{ repo: 'a/b', number: 1 }],
      features: ['F002'],
      removeFeatures: ['F001'],
    });
    assert.deepEqual(result.worktrees, ['/new']);
    assert.deepEqual(result.prs, [{ repo: 'c/d', number: 2 }]);
    assert.deepEqual(result.features, ['F002']);
  });
});

describe('parseThreadMetadataJson', () => {
  test('valid v1 JSON parses correctly', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const raw = JSON.stringify({
      v: 1,
      worktrees: ['/path'],
      prs: [{ repo: 'a/b', number: 1 }],
    });
    const result = parseThreadMetadataJson(raw);
    assert.ok(result);
    assert.equal(result.v, 1);
    assert.deepEqual(result.worktrees, ['/path']);
  });

  test('malformed JSON returns null (fail-open)', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson('not-json'), null);
  });

  test('wrong version returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 2 })), null);
  });

  test('non-object returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson('"string"'), null);
    assert.equal(parseThreadMetadataJson('42'), null);
    assert.equal(parseThreadMetadataJson('null'), null);
  });

  test('empty string returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson(''), null);
  });

  // Shape validation regression tests (P2: malformed v1 shapes must return null)
  test('worktrees as non-array returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, worktrees: 'abc' })), null);
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, worktrees: 123 })), null);
  });

  test('worktrees with non-string elements returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, worktrees: ['/ok', 42] })), null);
  });

  test('prs with invalid ref shape returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    // Not an array
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, prs: 'bad' })), null);
    // Missing repo
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, prs: [{ number: 1 }] })), null);
    // Non-positive number
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, prs: [{ repo: 'a/b', number: -1 }] })), null);
    // Non-integer number
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, prs: [{ repo: 'a/b', number: 1.5 }] })), null);
  });

  test('issues with invalid ref shape returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, issues: [{ repo: 'a', number: 'x' }] })), null);
  });

  test('features with non-string elements returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, features: [123, 'F001'] })), null);
  });

  test('notes as non-object returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, notes: [123] })), null);
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, notes: 'bad' })), null);
  });

  test('notes with non-string values returns null', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(parseThreadMetadataJson(JSON.stringify({ v: 1, notes: { ok: 'fine', bad: 42 } })), null);
  });

  test('valid v1 with all fields passes shape validation', async () => {
    const { parseThreadMetadataJson } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const result = parseThreadMetadataJson(
      JSON.stringify({
        v: 1,
        worktrees: ['/a', '/b'],
        prs: [{ repo: 'o/r', number: 1 }],
        issues: [{ repo: 'o/r', number: 2 }],
        features: ['F001'],
        notes: { key: 'value' },
      }),
    );
    assert.ok(result);
    assert.equal(result.v, 1);
    assert.deepEqual(result.worktrees, ['/a', '/b']);
  });
});

describe('ThreadStore (in-memory) — threadMetadata', () => {
  test('getThreadMetadata returns null for thread without metadata', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');
    assert.equal(store.getThreadMetadata(thread.id), null);
  });

  test('updateThreadMetadata sets and getThreadMetadata reads', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');
    const meta = {
      v: 1,
      worktrees: ['/path/a'],
      prs: [{ repo: 'owner/repo', number: 1 }],
      features: ['F001'],
      notes: { branch: 'feat/872' },
    };
    store.updateThreadMetadata(thread.id, meta);
    const result = store.getThreadMetadata(thread.id);
    assert.deepEqual(result, meta);
  });

  test('updateThreadMetadata(null) clears metadata', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');
    store.updateThreadMetadata(thread.id, { v: 1, worktrees: ['/x'] });
    assert.ok(store.getThreadMetadata(thread.id));
    store.updateThreadMetadata(thread.id, null);
    assert.equal(store.getThreadMetadata(thread.id), null);
  });

  test('updateThreadMetadata on nonexistent thread is no-op', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    // Should not throw
    store.updateThreadMetadata('nonexistent', { v: 1 });
    assert.equal(store.getThreadMetadata('nonexistent'), null);
  });

  test('threadMetadata persists through get()', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');
    store.updateThreadMetadata(thread.id, {
      v: 1,
      issues: [{ repo: 'zts212653/clowder-ai', number: 872 }],
    });
    const loaded = store.get(thread.id);
    assert.ok(loaded?.threadMetadata);
    assert.deepEqual(loaded.threadMetadata.issues, [{ repo: 'zts212653/clowder-ai', number: 872 }]);
  });
});

describe('atomicMergeThreadMetadata (in-memory)', () => {
  test('merges patch into empty metadata and returns result', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');
    const result = store.atomicMergeThreadMetadata(thread.id, {
      worktrees: ['/path/a'],
      prs: [{ repo: 'owner/repo', number: 1 }],
    });
    assert.deepEqual(result.worktrees, ['/path/a']);
    assert.deepEqual(result.prs, [{ repo: 'owner/repo', number: 1 }]);
    // Verify persisted
    assert.deepEqual(store.getThreadMetadata(thread.id), result);
  });

  test('merges into existing metadata with append+dedupe', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');
    store.updateThreadMetadata(thread.id, { v: 1, worktrees: ['/a'] });
    const result = store.atomicMergeThreadMetadata(thread.id, {
      worktrees: ['/a', '/b'],
    });
    assert.deepEqual(result.worktrees, ['/a', '/b']);
  });
});

describe('setThreadMetadataSchema validation (P2 PATCH-parity)', () => {
  // Import the schema from the built callbacks module isn't practical,
  // so we replicate the exact Zod schema definition to test it in isolation.
  let z;
  const refItemSchema = () => z.object({ repo: z.string().min(1).max(200), number: z.number().int().positive() });
  const buildSchema = () =>
    z.object({
      title: z.string().trim().min(1).max(200).optional(),
      labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
      worktrees: z.array(z.string().max(500)).max(20).optional(),
      prs: z.array(refItemSchema()).max(50).optional(),
      issues: z.array(refItemSchema()).max(50).optional(),
      features: z.array(z.string().max(50)).max(50).optional(),
      notes: z
        .record(z.string().max(100), z.string().max(2000).nullable())
        .refine((r) => Object.keys(r).length <= 50, { message: 'Too many notes (max 50)' })
        .optional(),
      removeWorktrees: z.array(z.string().max(500)).max(20).optional(),
      removePrs: z.array(refItemSchema()).max(50).optional(),
      removeIssues: z.array(refItemSchema()).max(50).optional(),
      removeFeatures: z.array(z.string().max(50)).max(50).optional(),
    });

  test('rejects whitespace-only title', async () => {
    z = (await import('zod')).z;
    const schema = buildSchema();
    const result = schema.safeParse({ title: '   ' });
    assert.equal(result.success, false);
  });

  test('trims title and accepts valid trimmed result', async () => {
    z = (await import('zod')).z;
    const schema = buildSchema();
    const result = schema.safeParse({ title: '  Hello  ' });
    assert.equal(result.success, true);
    assert.equal(result.data.title, 'Hello');
  });

  test('rejects title exceeding 200 chars', async () => {
    z = (await import('zod')).z;
    const schema = buildSchema();
    const result = schema.safeParse({ title: 'x'.repeat(201) });
    assert.equal(result.success, false);
  });

  test('rejects empty-string label after trim', async () => {
    z = (await import('zod')).z;
    const schema = buildSchema();
    const result = schema.safeParse({ labels: ['valid', '  '] });
    assert.equal(result.success, false);
  });

  test('trims label strings', async () => {
    z = (await import('zod')).z;
    const schema = buildSchema();
    const result = schema.safeParse({ labels: ['  abc  '] });
    assert.equal(result.success, true);
    assert.deepEqual(result.data.labels, ['abc']);
  });

  test('rejects more than 20 labels at schema level', async () => {
    z = (await import('zod')).z;
    const schema = buildSchema();
    const result = schema.safeParse({ labels: Array.from({ length: 21 }, (_, i) => `l${i}`) });
    assert.equal(result.success, false);
  });

  test('rejects more than 20 worktrees per request', async () => {
    z = (await import('zod')).z;
    const schema = buildSchema();
    const result = schema.safeParse({ worktrees: Array.from({ length: 21 }, (_, i) => `/path/${i}`) });
    assert.equal(result.success, false);
  });

  test('rejects worktree path exceeding 500 chars', async () => {
    z = (await import('zod')).z;
    const schema = buildSchema();
    const result = schema.safeParse({ worktrees: ['/' + 'a'.repeat(501)] });
    assert.equal(result.success, false);
  });

  test('rejects more than 50 features per request', async () => {
    z = (await import('zod')).z;
    const schema = buildSchema();
    const result = schema.safeParse({ features: Array.from({ length: 51 }, (_, i) => `F${i}`) });
    assert.equal(result.success, false);
  });

  test('rejects more than 50 notes', async () => {
    z = (await import('zod')).z;
    const schema = buildSchema();
    const notes = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, `v${i}`]));
    const result = schema.safeParse({ notes });
    assert.equal(result.success, false);
  });

  test('accepts payload within all caps', async () => {
    z = (await import('zod')).z;
    const schema = buildSchema();
    const result = schema.safeParse({
      worktrees: ['/path/a'],
      prs: [{ repo: 'owner/repo', number: 1 }],
      features: ['F001'],
      notes: { branch: 'main' },
    });
    assert.equal(result.success, true);
  });
});

describe('validateMergedTotals — post-merge rejection', () => {
  test('accepts metadata within limits', async () => {
    const { validateMergedTotals } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    // Should not throw
    validateMergedTotals({ v: 1, worktrees: Array.from({ length: 100 }, (_, i) => `/w/${i}`) });
  });

  test('rejects worktrees exceeding 100', async () => {
    const { validateMergedTotals, METADATA_TOTAL_LIMITS } = await import(
      '../dist/domains/cats/services/stores/ports/ThreadStore.js'
    );
    assert.equal(METADATA_TOTAL_LIMITS.worktrees, 100);
    assert.throws(
      () => validateMergedTotals({ v: 1, worktrees: Array.from({ length: 101 }, (_, i) => `/w/${i}`) }),
      /total limits exceeded.*worktrees: 101\/100/,
    );
  });

  test('rejects prs exceeding 200', async () => {
    const { validateMergedTotals } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const prs = Array.from({ length: 201 }, (_, i) => ({ repo: 'r', number: i + 1 }));
    assert.throws(() => validateMergedTotals({ v: 1, prs }), /total limits exceeded.*prs: 201\/200/);
  });

  test('rejects notes exceeding 200 keys', async () => {
    const { validateMergedTotals } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const notes = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, `v${i}`]));
    assert.throws(() => validateMergedTotals({ v: 1, notes }), /total limits exceeded.*notes: 201\/200/);
  });

  test('reports all violations at once', async () => {
    const { validateMergedTotals } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.throws(
      () =>
        validateMergedTotals({
          v: 1,
          worktrees: Array.from({ length: 101 }, (_, i) => `/w/${i}`),
          features: Array.from({ length: 201 }, (_, i) => `F${i}`),
        }),
      /worktrees: 101\/100.*features: 201\/200/,
    );
  });

  test('in-memory atomicMerge rejects when accumulated patches exceed limits', async () => {
    const { ThreadStore: MemStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new MemStore();
    const thread = store.create('u1', 'test');
    // Accumulate 6 batches × 20 worktrees each = 120 > 100 limit
    for (let batch = 0; batch < 5; batch++) {
      store.atomicMergeThreadMetadata(thread.id, {
        worktrees: Array.from({ length: 20 }, (_, i) => `/w/${batch * 20 + i}`),
      });
    }
    // 6th batch pushes to 120, should reject
    assert.throws(
      () =>
        store.atomicMergeThreadMetadata(thread.id, {
          worktrees: Array.from({ length: 20 }, (_, i) => `/w/${100 + i}`),
        }),
      /total limits exceeded/,
    );
    // Verify the 5th batch (100 worktrees) was the last successful write
    const meta = store.getThreadMetadata(thread.id);
    assert.equal(meta.worktrees.length, 100);
  });
});

describe('refKey', () => {
  test('generates lowercase dedupe key', async () => {
    const { refKey } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    assert.equal(refKey({ repo: 'Owner/Repo', number: 42 }), 'owner/repo#42');
  });
});
