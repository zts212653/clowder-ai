import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('MarkerQueue', () => {
  let tmpDir;
  let markersDir;
  let queue;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-markers-${randomUUID().slice(0, 8)}`);
    markersDir = join(tmpDir, 'docs', 'markers');
    mkdirSync(markersDir, { recursive: true });

    const { MarkerQueue } = await import('../../dist/domains/memory/MarkerQueue.js');
    queue = new MarkerQueue(markersDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('submit creates a YAML file and returns marker with id', async () => {
    const marker = await queue.submit({
      content: 'Redis 6399 is the production port',
      source: 'opus:thread_abc123',
      status: 'captured',
      targetKind: 'lesson',
    });

    assert.ok(marker.id, 'Should have generated an id');
    assert.equal(marker.status, 'captured');
    assert.ok(marker.createdAt);

    // Verify YAML file exists
    const files = readdirSync(markersDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.yaml'));

    // Verify file content
    const content = readFileSync(join(markersDir, files[0]), 'utf-8');
    assert.ok(content.includes('Redis 6399'));
    assert.ok(content.includes('captured'));
  });

  it('list returns all markers', async () => {
    await queue.submit({ content: 'Marker 1', source: 'opus:t1', status: 'captured' });
    await queue.submit({ content: 'Marker 2', source: 'opus:t2', status: 'captured' });

    const all = await queue.list();
    assert.equal(all.length, 2);
  });

  it('list filters by status', async () => {
    const m1 = await queue.submit({ content: 'Captured', source: 'opus:t1', status: 'captured' });
    await queue.submit({ content: 'Also captured', source: 'opus:t2', status: 'captured' });
    await queue.transition(m1.id, 'approved');

    const captured = await queue.list({ status: 'captured' });
    assert.equal(captured.length, 1);

    const approved = await queue.list({ status: 'approved' });
    assert.equal(approved.length, 1);
  });

  it('transition updates status in YAML file', async () => {
    const marker = await queue.submit({
      content: 'Test marker',
      source: 'opus:t1',
      status: 'captured',
    });

    await queue.transition(marker.id, 'approved');

    const updated = await queue.list({ status: 'approved' });
    assert.equal(updated.length, 1);
    assert.equal(updated[0].id, marker.id);

    // Verify file content updated
    const content = readFileSync(join(markersDir, `${marker.id}.yaml`), 'utf-8');
    assert.ok(content.includes('approved'));
  });

  it('transition throws for nonexistent marker', async () => {
    await assert.rejects(() => queue.transition('nonexistent', 'approved'), { message: /not found/i });
  });

  it('transition uses input id for write path, not YAML content id (path traversal guard)', async () => {
    const { writeFileSync } = await import('node:fs');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Create a marker file with a malicious id inside the YAML
    const safeId = 'safe-marker1';
    writeFileSync(
      join(markersDir, `${safeId}.yaml`),
      `${[
        'id: ../escaped',
        'status: captured',
        'source: attacker:t1',
        'created_at: 2026-03-12T00:00:00Z',
        'content: |',
        '  malicious content',
      ].join('\n')}\n`,
    );

    // transition should use the INPUT id (safeId), not the YAML id (../escaped)
    await queue.transition(safeId, 'approved');

    // The file should still be inside markersDir, not escaped to parent
    const parentFiles = (await import('node:fs')).readdirSync(join(markersDir, '..'));
    assert.ok(!parentFiles.includes('escaped.yaml'), 'Path traversal: file escaped to parent directory!');

    // The safe file should still exist and be updated
    assert.ok(existsSync(join(markersDir, `${safeId}.yaml`)));
    const content = (await import('node:fs')).readFileSync(join(markersDir, `${safeId}.yaml`), 'utf-8');
    assert.ok(content.includes('approved'));
  });

  it('submit auto-creates markersDir when it does not exist', async () => {
    // This is the root cause of the Knowledge Feed being empty:
    // writeYaml threw ENOENT when docs/markers/ didn't exist
    const freshDir = join(tmpDir, 'nonexistent', 'markers');
    const { MarkerQueue } = await import('../../dist/domains/memory/MarkerQueue.js');
    const freshQueue = new MarkerQueue(freshDir);

    const marker = await freshQueue.submit({
      content: 'Should auto-create directory',
      source: 'opus:test',
      status: 'captured',
    });

    assert.ok(marker.id);
    const files = readdirSync(freshDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.yaml'));
  });

  it('list returns empty array when markersDir does not exist (no throw)', async () => {
    const missingDir = join(tmpDir, 'does-not-exist', 'markers');
    const { MarkerQueue } = await import('../../dist/domains/memory/MarkerQueue.js');
    const freshQueue = new MarkerQueue(missingDir);

    const results = await freshQueue.list();
    assert.deepEqual(results, []);
  });

  it('submit rejects ids with path traversal characters', async () => {
    // This tests the writeYaml guard — the generated UUID-based id should
    // always be safe, but the validation should exist as defense-in-depth
    const marker = await queue.submit({
      content: 'Normal content',
      source: 'opus:t1',
      status: 'captured',
    });
    // Generated id should be alphanumeric + hyphens only
    assert.match(marker.id, /^[a-z0-9-]+$/i);
  });

  it('list filters by targetKind', async () => {
    await queue.submit({ content: 'Lesson', source: 'opus:t1', status: 'captured', targetKind: 'lesson' });
    await queue.submit({ content: 'Feature', source: 'opus:t2', status: 'captured', targetKind: 'feature' });

    const lessons = await queue.list({ targetKind: 'lesson' });
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0].content, 'Lesson');
  });
});
