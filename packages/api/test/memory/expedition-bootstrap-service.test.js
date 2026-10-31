import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  buildStructuralSummary,
  ExpeditionBootstrapService,
} from '../../dist/domains/memory/ExpeditionBootstrapService.js';
import { IndexStateManager } from '../../dist/domains/memory/IndexStateManager.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

function createTempProject() {
  const root = mkdtempSync(join(tmpdir(), 'f152-test-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'packages'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'test-project', workspaces: ['packages/*'] }));
  writeFileSync(join(root, 'docs', 'README.md'), '# Test Project\nSome docs.');
  writeFileSync(join(root, 'docs', 'ARCHITECTURE.md'), '# Architecture');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  return root;
}

describe('ExpeditionBootstrapService', () => {
  let db;
  let stateManager;
  let tmpRoot;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    stateManager = new IndexStateManager(db);
    tmpRoot = createTempProject();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function createService(overrides = {}) {
    return new ExpeditionBootstrapService(stateManager, {
      rebuildIndex: async () => ({ docsIndexed: 5, durationMs: 100 }),
      getFingerprint: () => 'abc123:1.0:full',
      ...overrides,
    });
  }

  describe('bootstrap orchestration', () => {
    it('completes full flow: scan → index → summary → ready', async () => {
      const svc = createService();
      const result = await svc.bootstrap(tmpRoot);
      assert.equal(result.status, 'ready');
      assert.ok(result.summary);
      assert.equal(result.summary.projectName, basename(tmpRoot));
      assert.ok(result.summary.techStack.includes('node'));
      assert.equal(result.docsIndexed, 5);
      assert.ok(result.durationMs >= 0);

      const state = stateManager.getState(tmpRoot);
      assert.equal(state.status, 'ready');
    });

    it('emits progress callbacks for all 4 phases', async () => {
      const phases = [];
      const svc = createService();
      await svc.bootstrap(tmpRoot, {
        onProgress: (p) => phases.push(p.phase),
      });
      assert.deepEqual(phases, ['scanning', 'extracting', 'indexing', 'summarizing']);
    });

    it('skips if fingerprint matches existing ready state', async () => {
      stateManager.startBuilding(tmpRoot, 'abc123:1.0:full');
      stateManager.markReady(tmpRoot, 5, '{}');
      const svc = createService();
      const result = await svc.bootstrap(tmpRoot);
      assert.equal(result.status, 'skipped');
    });

    it('skips if snoozed', async () => {
      stateManager.snooze(tmpRoot);
      const svc = createService();
      const result = await svc.bootstrap(tmpRoot);
      assert.equal(result.status, 'skipped');
    });

    it('re-bootstraps when fingerprint differs', async () => {
      stateManager.startBuilding(tmpRoot, 'old:1.0:full');
      stateManager.markReady(tmpRoot, 3, '{}');
      const svc = createService({ getFingerprint: () => 'new:2.0:full' });
      const result = await svc.bootstrap(tmpRoot);
      assert.equal(result.status, 'ready');
    });

    it('marks failed on indexer error and returns error', async () => {
      const svc = createService({
        rebuildIndex: async () => {
          throw new Error('disk full');
        },
      });
      const result = await svc.bootstrap(tmpRoot);
      assert.equal(result.status, 'failed');
      assert.equal(result.error, 'disk full');
      assert.equal(stateManager.getState(tmpRoot).status, 'failed');
    });
  });

  describe('security guardrails (AC-B12)', () => {
    it('rejects path with symlink escape', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'f152-outside-'));
      writeFileSync(join(outsideDir, 'secret.key'), 'secret');
      symlinkSync(outsideDir, join(tmpRoot, 'escape-link'));

      const svc = createService();
      const result = await svc.bootstrap(tmpRoot);
      assert.equal(result.status, 'ready');
      const summary = result.summary;
      const escapedPaths = summary.docsList.filter((d) => d.path.includes('escape-link'));
      assert.equal(escapedPaths.length, 0, 'symlinked dirs outside project must be excluded');

      rmSync(outsideDir, { recursive: true, force: true });
    });

    it('excludes secrets patterns from docsList', async () => {
      writeFileSync(join(tmpRoot, '.env'), 'SECRET=x');
      writeFileSync(join(tmpRoot, '.env.local'), 'LOCAL=y');
      writeFileSync(join(tmpRoot, 'credentials.json'), '{}');
      writeFileSync(join(tmpRoot, 'server.key'), 'key');
      writeFileSync(join(tmpRoot, 'cert.pem'), 'cert');

      const svc = createService();
      const result = await svc.bootstrap(tmpRoot);
      const paths = result.summary.docsList.map((d) => d.path);
      for (const secret of ['.env', '.env.local', 'credentials.json', 'server.key', 'cert.pem']) {
        assert.ok(!paths.some((p) => p.endsWith(secret)), `${secret} must be excluded`);
      }
    });

    it('enforces maxFiles budget', async () => {
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(tmpRoot, 'docs', `file${i}.md`), `# File ${i}`);
      }
      const svc = createService();
      const result = await svc.bootstrap(tmpRoot, { maxFiles: 5 });
      assert.ok(result.summary.docsList.length <= 5);
    });
  });
});

describe('buildStructuralSummary', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = createTempProject();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('detects node tech stack from package.json', () => {
    const summary = buildStructuralSummary(tmpRoot);
    assert.ok(summary.techStack.includes('node'));
  });

  it('detects typescript from tsconfig.json', () => {
    const summary = buildStructuralSummary(tmpRoot);
    assert.ok(summary.techStack.includes('typescript'));
  });

  it('lists top-level directories', () => {
    const summary = buildStructuralSummary(tmpRoot);
    assert.ok(summary.dirStructure.includes('src'));
    assert.ok(summary.dirStructure.includes('docs'));
    assert.ok(summary.dirStructure.includes('packages'));
  });

  it('excludes hidden directories from dir structure', () => {
    mkdirSync(join(tmpRoot, '.git'));
    mkdirSync(join(tmpRoot, 'node_modules'));
    const summary = buildStructuralSummary(tmpRoot);
    assert.ok(!summary.dirStructure.includes('.git'));
    assert.ok(!summary.dirStructure.includes('node_modules'));
  });

  it('finds docs with tier classification', () => {
    const summary = buildStructuralSummary(tmpRoot);
    assert.ok(summary.docsList.length > 0);
    const tiers = summary.docsList.map((d) => d.tier);
    assert.ok(tiers.includes('authoritative') || tiers.includes('derived'));
  });

  it('computes tier coverage counts', () => {
    const summary = buildStructuralSummary(tmpRoot);
    const total = Object.values(summary.tierCoverage).reduce((a, b) => a + b, 0);
    assert.equal(total, summary.docsList.length);
  });

  it('classifies docs/ subdirectory files as authoritative, not derived', () => {
    mkdirSync(join(tmpRoot, 'docs', 'features'), { recursive: true });
    writeFileSync(join(tmpRoot, 'docs', 'features', 'F152.md'), '# Feature');
    writeFileSync(join(tmpRoot, 'docs', 'plan.md'), '# Plan');
    const summary = buildStructuralSummary(tmpRoot);
    const docsUnderDocsDir = summary.docsList.filter(
      (d) => d.path.startsWith('docs/') && d.path !== 'docs/README.md' && d.path !== 'docs/ARCHITECTURE.md',
    );
    assert.ok(docsUnderDocsDir.length > 0, 'should find docs under docs/');
    for (const doc of docsUnderDocsDir) {
      assert.equal(doc.tier, 'authoritative', `${doc.path} should be authoritative, got ${doc.tier}`);
    }
  });

  it('classifies top-level non-special .md files as derived', () => {
    writeFileSync(join(tmpRoot, 'NOTES.md'), '# Notes');
    const summary = buildStructuralSummary(tmpRoot);
    const notes = summary.docsList.find((d) => d.path === 'NOTES.md');
    assert.ok(notes, 'should find NOTES.md');
    assert.equal(notes.tier, 'derived');
  });

  it('classifies top-level CHANGELOG as soft_clue but docs/CHANGELOG as authoritative', () => {
    writeFileSync(join(tmpRoot, 'CHANGELOG.md'), '# Changes');
    writeFileSync(join(tmpRoot, 'docs', 'CHANGELOG.md'), '# Doc Changes');
    const summary = buildStructuralSummary(tmpRoot);
    const topChangelog = summary.docsList.find((d) => d.path === 'CHANGELOG.md');
    assert.ok(topChangelog, 'should find top-level CHANGELOG');
    assert.equal(topChangelog.tier, 'soft_clue', 'top-level CHANGELOG should be soft_clue');
    const docsChangelog = summary.docsList.find((d) => d.path === 'docs/CHANGELOG.md');
    assert.ok(docsChangelog, 'should find docs/CHANGELOG');
    assert.equal(docsChangelog.tier, 'authoritative', 'docs/CHANGELOG should be authoritative (docs/ takes priority)');
  });

  it('bootstrap uses getTierCoverage from deps when available and syncs docsIndexed', async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const stateManager = new IndexStateManager(db);
    const storeTierCoverage = { authoritative: 42, derived: 8, soft_clue: 3 };
    const svc = new ExpeditionBootstrapService(stateManager, {
      rebuildIndex: async () => ({ docsIndexed: 999, durationMs: 100 }),
      getFingerprint: () => 'test:1.0:full',
      getTierCoverage: async (_projectPath) => storeTierCoverage,
    });
    const result = await svc.bootstrap(tmpRoot);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.summary.tierCoverage, storeTierCoverage);
    // P1-1 fix: docsIndexed must equal sum of tier counts
    assert.equal(result.docsIndexed, 42 + 8 + 3, 'docsIndexed should match tier coverage total');
  });

  it('bootstrap falls back to structural summary tiers when getTierCoverage is absent', async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const stateManager = new IndexStateManager(db);
    const svc = new ExpeditionBootstrapService(stateManager, {
      rebuildIndex: async () => ({ docsIndexed: 5, durationMs: 100 }),
      getFingerprint: () => 'test:2.0:full',
    });
    const result = await svc.bootstrap(tmpRoot);
    assert.equal(result.status, 'ready');
    assert.ok(Object.keys(result.summary.tierCoverage).length > 0, 'should have fallback tierCoverage');
  });

  it('bootstrap populates kindCoverage from getKindCoverage dep', async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const stateManager = new IndexStateManager(db);
    const storeKindCoverage = { feature: 10, decision: 3, lesson: 5, plan: 8 };
    const svc = new ExpeditionBootstrapService(stateManager, {
      rebuildIndex: async () => ({ docsIndexed: 26, durationMs: 100 }),
      getFingerprint: () => 'test:3.0:full',
      getKindCoverage: async (_projectPath) => storeKindCoverage,
    });
    const result = await svc.bootstrap(tmpRoot);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.summary.kindCoverage, storeKindCoverage);
  });

  it('bootstrap returns empty kindCoverage when getKindCoverage is absent', async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const stateManager = new IndexStateManager(db);
    const svc = new ExpeditionBootstrapService(stateManager, {
      rebuildIndex: async () => ({ docsIndexed: 5, durationMs: 100 }),
      getFingerprint: () => 'test:4.0:full',
    });
    const result = await svc.bootstrap(tmpRoot);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.summary.kindCoverage, {});
  });

  it('kindCoverage does not affect docsIndexed (tierCoverage owns that)', async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const stateManager = new IndexStateManager(db);
    const svc = new ExpeditionBootstrapService(stateManager, {
      rebuildIndex: async () => ({ docsIndexed: 50, durationMs: 100 }),
      getFingerprint: () => 'test:5.0:full',
      getKindCoverage: async () => ({ feature: 100, lesson: 200 }),
    });
    const result = await svc.bootstrap(tmpRoot);
    assert.equal(result.docsIndexed, 50, 'docsIndexed comes from rebuildIndex, not kindCoverage');
  });

  it('detects rust from Cargo.toml', () => {
    writeFileSync(join(tmpRoot, 'Cargo.toml'), '[package]\nname = "test"');
    const summary = buildStructuralSummary(tmpRoot);
    assert.ok(summary.techStack.includes('rust'));
  });

  it('detects python from pyproject.toml', () => {
    writeFileSync(join(tmpRoot, 'pyproject.toml'), '[project]\nname = "test"');
    const summary = buildStructuralSummary(tmpRoot);
    assert.ok(summary.techStack.includes('python'));
  });
});
