import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

function validPlanFrontmatter(overrides = '') {
  return `---
schemaVersion: 1
id: F209/f209-phase-d-orientation
title: F209 Phase D Orientation
featureIds: [F209]
ownerCatId: codex
intent: Orient a fresh cat on F209 Phase D evidence.
steps:
  - id: search-f209-spec
    type: search_evidence
    query: F209 Phase D Perspective runtime contract
    scope: docs
    mode: hybrid
    depth: raw
    limit: 5
    dimension: project
  - id: open-top-anchors
    type: open_anchor
    source: previous_step
    selector: top
    maxOpen: 3
outputPolicy:
  storesResults: false
  returnsConclusion: false
  requiresAnchors: true
${overrides}---

# F209 Phase D Orientation

Human notes live here; the runner must not treat this as a result set.
`;
}

function writePlan(root, relativePath, content = validPlanFrontmatter()) {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

describe('PerspectivePlanLoader', () => {
  let tmpRoot;
  let PerspectivePlanLoader;

  beforeEach(async () => {
    tmpRoot = join(tmpdir(), `f209-perspective-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpRoot, { recursive: true });
    ({ PerspectivePlanLoader } = await import('../../dist/domains/memory/PerspectivePlanLoader.js'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('loads a valid schema v1 plan from docs/perspectives', async () => {
    writePlan(tmpRoot, 'docs/perspectives/F209/f209-phase-d-orientation.md');
    const loader = new PerspectivePlanLoader({ repoRoot: tmpRoot });

    const loaded = await loader.loadByPath('docs/perspectives/F209/f209-phase-d-orientation.md');

    assert.equal(loaded.plan.schemaVersion, 1);
    assert.equal(loaded.plan.id, 'F209/f209-phase-d-orientation');
    assert.equal(loaded.plan.outputPolicy.storesResults, false);
    assert.equal(loaded.plan.outputPolicy.returnsConclusion, false);
    assert.equal(loaded.plan.steps.length, 2);
    assert.equal(loaded.relativePath, 'docs/perspectives/F209/f209-phase-d-orientation.md');
    assert.match(loaded.body, /Human notes live here/);
  });

  it('loads the checked-in F209 orientation fixture', async () => {
    const loader = new PerspectivePlanLoader({ repoRoot });

    const loaded = await loader.loadById('F209/f209-phase-d-orientation');

    assert.equal(loaded.plan.id, 'F209/f209-phase-d-orientation');
    assert.equal(loaded.plan.featureIds[0], 'F209');
    assert.equal(loaded.plan.outputPolicy.requiresAnchors, true);
  });

  it('rejects plans whose frontmatter id does not match the requested path', async () => {
    const mismatched = validPlanFrontmatter().replace(
      'id: F209/f209-phase-d-orientation',
      'id: F209/copied-from-elsewhere',
    );
    writePlan(tmpRoot, 'docs/perspectives/F209/f209-phase-d-orientation.md', mismatched);
    const loader = new PerspectivePlanLoader({ repoRoot: tmpRoot });

    await assert.rejects(() => loader.loadById('F209/f209-phase-d-orientation'), {
      message: /id.*F209\/copied-from-elsewhere.*does not match.*F209\/f209-phase-d-orientation/i,
    });
  });

  it('rejects paths outside docs/perspectives', async () => {
    writePlan(tmpRoot, 'docs/features/escaped.md');
    const loader = new PerspectivePlanLoader({ repoRoot: tmpRoot });

    await assert.rejects(() => loader.loadByPath('docs/features/escaped.md'), {
      message: /docs\/perspectives/,
    });
  });

  it('rejects symlinked plans whose canonical target escapes docs/perspectives', async () => {
    const externalPlanPath = writePlan(
      tmpRoot,
      'outside/symlinked-plan.md',
      validPlanFrontmatter().replace('id: F209/f209-phase-d-orientation', 'id: F209/symlinked-plan'),
    );
    const linkPath = join(tmpRoot, 'docs/perspectives/F209/symlinked-plan.md');
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(externalPlanPath, linkPath);
    const loader = new PerspectivePlanLoader({ repoRoot: tmpRoot });

    await assert.rejects(() => loader.loadById('F209/symlinked-plan'), {
      message: /docs\/perspectives/,
    });
  });

  it('rejects unsupported schema versions', async () => {
    writePlan(
      tmpRoot,
      'docs/perspectives/F209/bad-version.md',
      validPlanFrontmatter().replace('schemaVersion: 1', 'schemaVersion: 2'),
    );
    const loader = new PerspectivePlanLoader({ repoRoot: tmpRoot });

    await assert.rejects(() => loader.loadByPath('docs/perspectives/F209/bad-version.md'), {
      message: /schemaVersion/,
    });
  });

  it('rejects plans that store results or return conclusions', async () => {
    const unsafe = validPlanFrontmatter()
      .replace('storesResults: false', 'storesResults: true')
      .replace('returnsConclusion: false', 'returnsConclusion: true');
    writePlan(tmpRoot, 'docs/perspectives/F209/unsafe.md', unsafe);
    const loader = new PerspectivePlanLoader({ repoRoot: tmpRoot });

    await assert.rejects(() => loader.loadByPath('docs/perspectives/F209/unsafe.md'), {
      message: /storesResults|returnsConclusion/,
    });
  });

  it('rejects duplicate step ids', async () => {
    const duplicated = validPlanFrontmatter().replace('id: open-top-anchors', 'id: search-f209-spec');
    writePlan(tmpRoot, 'docs/perspectives/F209/duplicate.md', duplicated);
    const loader = new PerspectivePlanLoader({ repoRoot: tmpRoot });

    await assert.rejects(() => loader.loadByPath('docs/perspectives/F209/duplicate.md'), {
      message: /duplicate.*step/i,
    });
  });

  it('rejects open_anchor steps without bounded maxOpen', async () => {
    const missingMaxOpen = validPlanFrontmatter().replace('\n    maxOpen: 3', '');
    writePlan(tmpRoot, 'docs/perspectives/F209/missing-max-open.md', missingMaxOpen);
    const loader = new PerspectivePlanLoader({ repoRoot: tmpRoot });

    await assert.rejects(() => loader.loadByPath('docs/perspectives/F209/missing-max-open.md'), {
      message: /maxOpen/,
    });

    const tooLarge = validPlanFrontmatter().replace('maxOpen: 3', 'maxOpen: 11');
    writePlan(tmpRoot, 'docs/perspectives/F209/large-max-open.md', tooLarge);
    await assert.rejects(() => loader.loadByPath('docs/perspectives/F209/large-max-open.md'), {
      message: /maxOpen/,
    });
  });

  it('rejects unsupported open_anchor selectors in v1', async () => {
    const unsupportedSelector = validPlanFrontmatter().replace('selector: top', 'selector: by_anchor');
    writePlan(tmpRoot, 'docs/perspectives/F209/unsupported-selector.md', unsupportedSelector);
    const loader = new PerspectivePlanLoader({ repoRoot: tmpRoot });

    await assert.rejects(() => loader.loadByPath('docs/perspectives/F209/unsupported-selector.md'), {
      message: /selector/,
    });
  });
});
