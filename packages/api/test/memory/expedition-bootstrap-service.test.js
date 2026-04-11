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
