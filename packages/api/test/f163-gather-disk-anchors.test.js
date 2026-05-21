import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gatherDiskAnchors } from '../dist/routes/f163-audit-routes.js';

describe('gatherDiskAnchors', () => {
  it('extracts anchors from docs/features/ filenames (with and without hyphen)', () => {
    const root = mkdtempSync(join(tmpdir(), 'disk-anchors-'));
    const featDir = join(root, 'features');
    mkdirSync(featDir);
    writeFileSync(join(featDir, 'F042.md'), '');
    writeFileSync(join(featDir, 'F188-library.md'), '');
    writeFileSync(join(featDir, 'README.md'), '');

    try {
      const anchors = gatherDiskAnchors(root);
      assert.ok(anchors, 'should return anchors');
      assert.ok(anchors.has('F042'), 'F042.md without hyphen should be found');
      assert.ok(anchors.has('F188'), 'F188-library.md with hyphen should be found');
      assert.ok(!anchors.has('README'), 'README.md should not match');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('extracts anchors from BACKLOG.md table rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'disk-anchors-'));
    writeFileSync(
      join(root, 'BACKLOG.md'),
      [
        '| F038 | Skills 梳理 | parked | 三猫 |',
        '| F044 | Channel System | spec | 布偶猫 |',
        'Some random text F999 not in table',
      ].join('\n'),
    );

    try {
      const anchors = gatherDiskAnchors(root);
      assert.ok(anchors, 'should return anchors');
      assert.ok(anchors.has('F038'), 'F038 from BACKLOG table should be found');
      assert.ok(anchors.has('F044'), 'F044 from BACKLOG table should be found');
      assert.ok(!anchors.has('F999'), 'F999 not in table format should not match');
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('merges anchors from both sources', () => {
    const root = mkdtempSync(join(tmpdir(), 'disk-anchors-'));
    const featDir = join(root, 'features');
    mkdirSync(featDir);
    writeFileSync(join(featDir, 'F188-library.md'), '');
    writeFileSync(join(root, 'BACKLOG.md'), '| F042 | New feat | spec | 猫 |\n');

    try {
      const anchors = gatherDiskAnchors(root);
      assert.ok(anchors, 'should return anchors');
      assert.ok(anchors.has('F188'), 'from features/ dir');
      assert.ok(anchors.has('F042'), 'from BACKLOG.md');
      assert.equal(anchors.size, 2);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('returns undefined when docsRoot is undefined', () => {
    assert.equal(gatherDiskAnchors(undefined), undefined);
  });

  it('returns undefined when neither source exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'disk-anchors-'));
    try {
      const anchors = gatherDiskAnchors(root);
      assert.equal(anchors, undefined);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
