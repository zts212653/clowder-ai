import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const { resolveMemoryRepoPaths } = await import('../dist/utils/memory-root.js');

describe('resolveMemoryRepoPaths', () => {
  const tmpDirs = [];

  function createTempMonorepo() {
    const repoRoot = mkdtempSync(join(tmpdir(), 'memory-root-'));
    tmpDirs.push(repoRoot);
    mkdirSync(join(repoRoot, 'packages', 'api'), { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    return repoRoot;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the monorepo root when a nested packages/api docs/features placeholder exists', () => {
    const repoRoot = createTempMonorepo();
    mkdirSync(join(repoRoot, 'docs', 'features'), { recursive: true });
    mkdirSync(join(repoRoot, 'packages', 'api', 'docs', 'features'), { recursive: true });
    writeFileSync(join(repoRoot, 'docs', 'features', 'F102-memory.md'), '# F102 Memory\n');
    writeFileSync(join(repoRoot, 'packages', 'api', 'docs', 'features', 'TEMPLATE.md'), '# Template\n');

    const result = resolveMemoryRepoPaths(join(repoRoot, 'packages', 'api'), {});

    assert.equal(result.repoRoot, repoRoot);
    assert.equal(result.docsRoot, join(repoRoot, 'docs'));
    assert.equal(result.markersDir, join(repoRoot, 'docs', 'markers'));
  });

  it('keeps DOCS_ROOT as an explicit override for evidence indexing docs', () => {
    const repoRoot = createTempMonorepo();
    const docsOverride = join(repoRoot, 'custom-docs');
    mkdirSync(docsOverride, { recursive: true });

    const result = resolveMemoryRepoPaths(join(repoRoot, 'packages', 'api'), {
      DOCS_ROOT: docsOverride,
    });

    assert.equal(result.repoRoot, repoRoot);
    assert.equal(result.docsRoot, docsOverride);
    assert.equal(result.markersDir, join(docsOverride, 'markers'));
  });
});
