import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';

describe('handoff digest IO', () => {
  let tempDir;
  let reader;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'handoff-io-'));
    reader = new TranscriptReader({ dataDir: tempDir });
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  // --- readHandoffDigest ---

  test('readHandoffDigest returns parsed result when file exists', async () => {
    const dir = join(tempDir, 'threads', 'thread1', 'cat1', 'sessions', 'sess1');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'digest.handoff.md'),
      [
        '---',
        'v: 1',
        'model: claude-haiku-4-5-20251001',
        'generatedAt: 1709700000000',
        '---',
        '',
        '## Session Summary',
        'Cat worked on feature X.',
      ].join('\n'),
    );

    const result = await reader.readHandoffDigest('sess1', 'thread1', 'cat1');
    assert.ok(result);
    assert.equal(result.v, 1);
    assert.equal(result.model, 'claude-haiku-4-5-20251001');
    assert.ok(result.body.includes('Session Summary'));
    assert.ok(result.body.includes('feature X'));
  });

  test('readHandoffDigest returns null when file missing', async () => {
    const result = await reader.readHandoffDigest('nope', 'thread1', 'cat1');
    assert.equal(result, null);
  });

  test('readHandoffDigest returns null on malformed frontmatter', async () => {
    const dir = join(tempDir, 'threads', 'thread1', 'cat1', 'sessions', 'sess-bad');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'digest.handoff.md'), 'no frontmatter here');

    const result = await reader.readHandoffDigest('sess-bad', 'thread1', 'cat1');
    assert.equal(result, null);
  });

  // --- writeHandoffDigest ---

  test('writeHandoffDigest writes YAML frontmatter + markdown body', async () => {
    const sessionDir = join(tempDir, 'threads', 'thread1', 'cat1', 'sessions', 'sess-write');
    await mkdir(sessionDir, { recursive: true });

    await TranscriptWriter.writeHandoffDigest(
      sessionDir,
      {
        v: 1,
        model: 'claude-haiku-4-5-20251001',
        generatedAt: 1709700000000,
      },
      '## Summary\nDid things.',
    );

    const content = await readFile(join(sessionDir, 'digest.handoff.md'), 'utf-8');
    assert.ok(content.startsWith('---\n'));
    assert.ok(content.includes('v: 1'));
    assert.ok(content.includes('model: claude-haiku-4-5-20251001'));
    assert.ok(content.includes('generatedAt: 1709700000000'));
    assert.ok(content.includes('## Summary'));
    assert.ok(content.includes('Did things.'));
  });

  // --- readAllEvents ---

  test('readAllEvents returns all events without limit', async () => {
    const dir = join(tempDir, 'threads', 'thread1', 'cat1', 'sessions', 'sess-all');
    await mkdir(dir, { recursive: true });

    // Write 100 events — more than the default limit of 50
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(
        JSON.stringify({
          v: 1,
          t: 1709700000000 + i,
          threadId: 'thread1',
          catId: 'cat1',
          sessionId: 'sess-all',
          cliSessionId: 'cli1',
          eventNo: i,
          event: { type: 'text', content: `msg ${i}` },
        }),
      );
    }
    await writeFile(join(dir, 'events.jsonl'), lines.join('\n'));

    const events = await reader.readAllEvents('sess-all', 'thread1', 'cat1');
    assert.equal(events.length, 100);
    assert.equal(events[0].eventNo, 0);
    assert.equal(events[99].eventNo, 99);
  });

  test('readAllEvents returns empty array when no transcript', async () => {
    const events = await reader.readAllEvents('nope', 'thread1', 'cat1');
    assert.deepEqual(events, []);
  });

  test('scanEvents visits a transcript incrementally without returning an event array', async () => {
    const dir = join(tempDir, 'threads', 'thread1', 'cat1', 'sessions', 'sess-scan');
    await mkdir(dir, { recursive: true });
    const lines = Array.from({ length: 10_000 }, (_, index) =>
      JSON.stringify({
        v: 1,
        t: 1709700000000 + index,
        threadId: 'thread1',
        catId: 'cat1',
        sessionId: 'sess-scan',
        eventNo: index,
        event: { type: 'status', content: 'x'.repeat(1_024) },
      }),
    );
    await writeFile(join(dir, 'events.jsonl'), lines.join('\n'));
    let visited = 0;

    const result = await reader.scanEvents('sess-scan', 'thread1', 'cat1', () => {
      visited += 1;
    });

    assert.deepEqual(result, { present: true, eventCount: 10_000 });
    assert.equal(visited, 10_000);
  });

  test('scanEvents propagates visitor failures instead of silently skipping safety budgets', async () => {
    const dir = join(tempDir, 'threads', 'thread1', 'cat1', 'sessions', 'sess-budget');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'events.jsonl'),
      JSON.stringify({
        v: 1,
        t: 1709700000000,
        threadId: 'thread1',
        catId: 'cat1',
        sessionId: 'sess-budget',
        eventNo: 0,
        event: { type: 'status' },
      }),
    );

    await assert.rejects(
      reader.scanEvents('sess-budget', 'thread1', 'cat1', () => {
        throw new Error('budget_exceeded');
      }),
      /budget_exceeded/,
    );
  });

  // --- getSessionDir (public accessor) ---

  test('getSessionDir returns correct path', () => {
    const dir = reader.getSessionDir('thread1', 'cat1', 'sess1');
    assert.equal(dir, join(tempDir, 'threads', 'thread1', 'cat1', 'sessions', 'sess1'));
  });
});
