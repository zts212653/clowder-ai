import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { TasteMemoryLifecycleStore } from '../dist/domains/memory/taste/TasteMemoryLifecycleStore.js';
import { importTasteTakeawayCandidates } from '../dist/domains/memory/taste/TasteTakeawayCandidateImporter.js';

const publicDraftPath = 'docs/features/evidence/F321/takeaway-drafts.public.json';

function revisionOf(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function privateVignette(quote) {
  return `---\nwhen: 2026-10-06\nquotes: ["${quote}"]\nscene: "Private candidate"\ntags: ["private"]\ndimension: relationship-stance\nprivacy: sensitive\n---\n`;
}

describe('F321 Taste takeaway candidate importer', () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('canonicalizes synthetic 75 public and 2 private drafts as TTL-free revision-bound pending confirmations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f321-taste-candidates-'));
    roots.push(root);
    const drafts = Array.from({ length: 75 }, (_, index) => {
      const sourcePath = `docs/taste/vignettes/public-${index + 1}.md`;
      const content = privateVignette(`public-${index + 1}`).replace('privacy: sensitive', 'privacy: public');
      mkdirSync(dirname(join(root, sourcePath)), { recursive: true });
      writeFileSync(join(root, sourcePath), content);
      return {
        sourcePath,
        takeaway: `Synthetic candidate ${index + 1} awaits owner confirmation.`,
        sourceRevision: revisionOf(content),
      };
    });
    mkdirSync(dirname(join(root, publicDraftPath)), { recursive: true });
    writeFileSync(
      join(root, publicDraftPath),
      JSON.stringify({ schemaVersion: 1, status: 'cat_draft_unconfirmed', drafts }),
    );

    const privateDrafts = ['private/taste/private-one.md', 'private/taste/private-two.md'].map((sourcePath, index) => {
      const content = privateVignette(`private-${index + 1}`);
      mkdirSync(dirname(join(root, sourcePath)), { recursive: true });
      writeFileSync(join(root, sourcePath), content, 'utf8');
      return {
        sourcePath,
        takeaway: `Synthetic private candidate ${index + 1} awaits owner confirmation.`,
        sourceRevision: revisionOf(content),
      };
    });
    const privateDraftFile = join(root, 'private/f321/takeaway-drafts.json');
    mkdirSync(dirname(privateDraftFile), { recursive: true });
    writeFileSync(
      privateDraftFile,
      `${JSON.stringify({ schemaVersion: 1, status: 'cat_draft_unconfirmed', drafts: privateDrafts }, null, 2)}\n`,
      'utf8',
    );

    const db = new Database(':memory:');
    applyMigrations(db);
    const result = await importTasteTakeawayCandidates({
      repository: { canonicalRoot: () => root, approvalLockKey: () => 'candidate-test' },
      lifecycleStore: new TasteMemoryLifecycleStore(db),
      ownerUserId: 'candidate-owner',
    });
    assert.deepEqual(result, { imported: 77, stale: 0, unavailableInputs: [] });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM taste_takeaway_candidates WHERE status = 'pending'").get().count,
      77,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM taste_takeaway_candidates').get().count, 77);
    db.close();
  });
  it('starts without importing optional drafts when the checkout has no main worktree', async () => {
    const { FileTasteRepository } = await import('../dist/domains/taste/services/TasteRepository.js');
    const root = mkdtempSync(join(tmpdir(), 'f321-branch-only-'));
    roots.push(root);
    execFileSync('git', ['init', '-b', 'feature'], { cwd: root, stdio: 'ignore' });
    const repository = new FileTasteRepository(root);
    assert.throws(() => repository.canonicalRoot(), /checked-out refs\/heads\/main/);
    const db = new Database(':memory:');
    try {
      applyMigrations(db);
      const result = await importTasteTakeawayCandidates({
        repository,
        lifecycleStore: new TasteMemoryLifecycleStore(db),
        ownerUserId: 'candidate-owner',
      });
      assert.deepEqual(result, {
        imported: 0,
        stale: 0,
        unavailableInputs: [publicDraftPath, 'private/f321/takeaway-drafts.json'],
      });
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM taste_takeaway_candidates').get().count, 0);
      // No alternate approval root is granted to the feature checkout.
      assert.throws(() => repository.canonicalRoot(), /checked-out refs\/heads\/main/);
    } finally {
      db.close();
    }
  });
});
