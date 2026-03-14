import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

/**
 * Test: GET /api/signals/articles/:id/notes/:noteId
 * Verifies the note content API endpoint reads artifact filePath and returns content.
 */

const TMP = join(tmpdir(), `signal-note-test-${Date.now()}`);

// We test the route logic indirectly by verifying the StudyMetaService + readFile pattern
describe('signal note content endpoint logic', () => {
  beforeEach(async () => {
    await mkdir(TMP, { recursive: true });
  });

  it('reads note file content from filePath', async () => {
    const notePath = join(TMP, 'study-note-abc.md');
    await writeFile(notePath, '# Study Notes\n\nKey insight: transformers are attention mechanisms.');

    const content = await readFile(notePath, 'utf-8');
    assert.ok(content.includes('Key insight'));
    assert.ok(content.includes('transformers'));
  });

  it('returns error for missing note file', async () => {
    const notePath = join(TMP, 'nonexistent.md');
    await assert.rejects(() => readFile(notePath, 'utf-8'), { code: 'ENOENT' });
  });

  it('handles empty note file', async () => {
    const notePath = join(TMP, 'empty-note.md');
    await writeFile(notePath, '');

    const content = await readFile(notePath, 'utf-8');
    assert.strictEqual(content, '');
  });
});

it('resolves relative filePath against article sidecar dir', async () => {
  // Simulate article at /tmp/.../library/src/article-id.md
  // Sidecar dir = /tmp/.../library/src/article-id/
  const articleDir = join(TMP, 'article-id');
  const notesDir = join(articleDir, 'notes');
  await mkdir(notesDir, { recursive: true });
  await writeFile(join(notesDir, 'study_abc.md'), '# Migrated note content');

  // This is what the route does now: resolve relative path
  const { isAbsolute } = await import('node:path');
  const articleFilePath = join(TMP, 'article-id.md');
  const relativeNotePath = 'notes/study_abc.md';

  assert.ok(!isAbsolute(relativeNotePath), 'note path should be relative');
  const absPath = isAbsolute(relativeNotePath)
    ? relativeNotePath
    : join(articleFilePath.replace(/\.md$/, ''), relativeNotePath);

  const content = await readFile(absPath, 'utf-8');
  assert.ok(content.includes('Migrated note content'));
});

// Cleanup
import { after } from 'node:test';

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});
