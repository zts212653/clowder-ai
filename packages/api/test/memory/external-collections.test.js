import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

describe('external-collections', () => {
  let loadExternalCollections, saveExternalCollection;
  let dataDir;

  beforeEach(async () => {
    ({ loadExternalCollections, saveExternalCollection } = await import(
      '../../dist/domains/memory/external-collections.js'
    ));
    dataDir = mkdtempSync(join(tmpdir(), 'ext-col-'));
  });

  it('returns empty array when no collections.json exists', () => {
    const result = loadExternalCollections(dataDir);
    assert.deepEqual(result, []);
  });

  it('loads manifests from collections.json', () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'col-root-'));
    const manifest = {
      id: 'world:test',
      kind: 'world',
      name: 'test',
      displayName: 'Test World',
      root: contentDir,
      sensitivity: 'internal',
      scannerLevel: 1,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    mkdirSync(join(dataDir, 'library'), { recursive: true });
    writeFileSync(join(dataDir, 'library', 'collections.json'), JSON.stringify([manifest]));
    const result = loadExternalCollections(dataDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'world:test');
  });

  it('saveExternalCollection appends to existing file', () => {
    mkdirSync(join(dataDir, 'library'), { recursive: true });
    const m1 = {
      id: 'world:a',
      kind: 'world',
      name: 'a',
      displayName: 'A',
      root: '/a',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    writeFileSync(join(dataDir, 'library', 'collections.json'), JSON.stringify([m1]));
    const m2 = { ...m1, id: 'world:b', name: 'b', displayName: 'B', root: '/b' };
    saveExternalCollection(dataDir, m2);
    const saved = JSON.parse(readFileSync(join(dataDir, 'library', 'collections.json'), 'utf-8'));
    assert.equal(saved.length, 2);
  });

  it('saveExternalCollection creates file when absent', () => {
    const m = {
      id: 'world:new',
      kind: 'world',
      name: 'new',
      displayName: 'New',
      root: '/new',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    saveExternalCollection(dataDir, m);
    const saved = JSON.parse(readFileSync(join(dataDir, 'library', 'collections.json'), 'utf-8'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'world:new');
  });

  it('skips manifests with invalid sensitivity on load', () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'col-badsens-'));
    const bad = {
      id: 'world:badsens',
      kind: 'world',
      name: 'badsens',
      displayName: 'Bad Sens',
      root: contentDir,
      sensitivity: 'banana',
      scannerLevel: 1,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    mkdirSync(join(dataDir, 'library'), { recursive: true });
    writeFileSync(join(dataDir, 'library', 'collections.json'), JSON.stringify([bad]));
    const result = loadExternalCollections(dataDir);
    assert.equal(result.length, 0);
  });

  it('skips manifests with invalid kind on load', () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'col-badkind-'));
    const bad = {
      id: 'banana:test',
      kind: 'banana',
      name: 'test',
      displayName: 'Bad Kind',
      root: contentDir,
      sensitivity: 'internal',
      scannerLevel: 1,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    mkdirSync(join(dataDir, 'library'), { recursive: true });
    writeFileSync(join(dataDir, 'library', 'collections.json'), JSON.stringify([bad]));
    const result = loadExternalCollections(dataDir);
    assert.equal(result.length, 0);
  });

  it('keeps valid manifests and skips invalid ones on load', () => {
    const goodDir = mkdtempSync(join(tmpdir(), 'col-good-'));
    const badDir = mkdtempSync(join(tmpdir(), 'col-bad-'));
    const good = {
      id: 'world:good',
      kind: 'world',
      name: 'good',
      displayName: 'Good',
      root: goodDir,
      sensitivity: 'internal',
      scannerLevel: 1,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    const bad = {
      id: 'world:bad',
      kind: 'world',
      name: 'bad',
      displayName: 'Bad',
      root: badDir,
      sensitivity: 'banana',
      scannerLevel: 1,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    mkdirSync(join(dataDir, 'library'), { recursive: true });
    writeFileSync(join(dataDir, 'library', 'collections.json'), JSON.stringify([good, bad]));
    const result = loadExternalCollections(dataDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'world:good');
  });

  it('skips manifests with non-existent root paths', () => {
    const manifest = {
      id: 'world:gone',
      kind: 'world',
      name: 'gone',
      displayName: 'Gone',
      root: '/nonexistent/path/that/does/not/exist',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: '2026-05-04',
      updatedAt: '2026-05-04',
    };
    mkdirSync(join(dataDir, 'library'), { recursive: true });
    writeFileSync(join(dataDir, 'library', 'collections.json'), JSON.stringify([manifest]));
    const result = loadExternalCollections(dataDir);
    assert.equal(result.length, 0);
  });
});
