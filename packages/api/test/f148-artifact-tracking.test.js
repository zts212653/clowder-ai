/**
 * F148 Phase H: Artifact Deterministic Tracking
 *
 * Tests for extractRecentArtifacts, navigation header rendering,
 * and ThreadMemory backward compatibility.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { extractRecentArtifacts, sortAndCapArtifacts } = await import(
  '../dist/domains/cats/services/agents/routing/artifact-tracking.js'
);
const { formatNavigationHeader } = await import('../dist/domains/cats/services/agents/routing/navigation-context.js');
const { buildBriefingMessage } = await import('../dist/domains/cats/services/agents/routing/format-briefing.js');

describe('extractRecentArtifacts', () => {
  it('extracts artifacts from filesTouched with write ops', () => {
    const filesTouched = [
      { path: 'packages/api/src/routes/callbacks.ts', ops: ['edit'] },
      { path: 'packages/api/test/callbacks.test.js', ops: ['create'] },
      { path: 'docs/features/F148-hierarchical-context-transport.md', ops: ['read'] },
    ];
    const result = extractRecentArtifacts({ filesTouched, prTasks: [], catId: 'opus' });
    assert.ok(result.length >= 1, 'should extract at least write-op files');
    assert.ok(
      result.every((a) => a.ops !== undefined),
      'each artifact should have ops',
    );
    assert.ok(
      result.every((a) => typeof a.updatedAt === 'number'),
      'each artifact should have updatedAt',
    );
    const readOnly = result.find((a) => a.ref === 'docs/features/F148-hierarchical-context-transport.md');
    assert.equal(readOnly, undefined, 'read-only files should be excluded');
  });

  it('extracts PR artifacts from pr_tracking tasks', () => {
    const prTasks = [
      {
        id: 't1',
        kind: 'pr_tracking',
        subjectKey: 'pr:zts212653/cat-cafe#1292',
        title: 'PR tracking: zts212653/cat-cafe#1292',
        ownerCatId: 'opus',
        status: 'todo',
        updatedAt: Date.now(),
      },
    ];
    const result = extractRecentArtifacts({ filesTouched: [], prTasks, catId: 'opus' });
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'pr');
    assert.ok(result[0].ref.includes('#1292'));
  });

  it('deduplicates and caps at 5 artifacts', () => {
    const filesTouched = Array.from({ length: 10 }, (_, i) => ({
      path: `packages/api/src/file-${i}.ts`,
      ops: ['edit'],
    }));
    const result = extractRecentArtifacts({ filesTouched, prTasks: [], catId: 'opus' });
    assert.ok(result.length <= 5, `should cap at 5, got ${result.length}`);
  });

  it('returns empty array when no artifacts', () => {
    const result = extractRecentArtifacts({ filesTouched: [], prTasks: [], catId: 'opus' });
    assert.deepEqual(result, []);
  });

  it('prioritizes PRs over files when PR is most recent', () => {
    const filesTouched = Array.from({ length: 5 }, (_, i) => ({
      path: `packages/api/src/file-${i}.ts`,
      ops: ['edit'],
    }));
    const prTasks = [
      {
        id: 't1',
        kind: 'pr_tracking',
        subjectKey: 'pr:zts212653/cat-cafe#1292',
        title: 'PR #1292',
        ownerCatId: 'opus',
        status: 'todo',
        updatedAt: Date.now() + 60_000,
      },
    ];
    const result = extractRecentArtifacts({ filesTouched, prTasks, catId: 'opus' });
    assert.equal(result[0].type, 'pr', 'PR should be first when most recent');
  });

  it('sorts results by updatedAt DESC (P2-1: recency semantics)', () => {
    const now = Date.now();
    const prTasks = [
      {
        id: 't1',
        kind: 'pr_tracking',
        subjectKey: 'pr:zts212653/cat-cafe#100',
        title: 'PR #100',
        ownerCatId: 'opus',
        status: 'todo',
        updatedAt: now - 30_000, // oldest
      },
      {
        id: 't2',
        kind: 'pr_tracking',
        subjectKey: 'pr:zts212653/cat-cafe#200',
        title: 'PR #200',
        ownerCatId: 'opus',
        status: 'todo',
        updatedAt: now, // newest
      },
      {
        id: 't3',
        kind: 'pr_tracking',
        subjectKey: 'pr:zts212653/cat-cafe#150',
        title: 'PR #150',
        ownerCatId: 'opus',
        status: 'todo',
        updatedAt: now - 10_000, // middle
      },
    ];
    const result = extractRecentArtifacts({ filesTouched: [], prTasks, catId: 'opus' });
    assert.equal(result.length, 3);
    assert.ok(result[0].updatedAt >= result[1].updatedAt, 'first should be newest');
    assert.ok(result[1].updatedAt >= result[2].updatedAt, 'second should be newer than third');
    assert.ok(result[0].ref.includes('#200'), 'newest PR should be first');
    assert.ok(result[2].ref.includes('#100'), 'oldest PR should be last');
  });

  it('classifies feature docs and plans by path', () => {
    const filesTouched = [
      { path: 'docs/features/F148-foo.md', ops: ['edit'] },
      { path: 'docs/plans/2026-04-20-bar.md', ops: ['create'] },
      { path: 'packages/api/src/index.ts', ops: ['edit'] },
    ];
    const result = extractRecentArtifacts({ filesTouched, prTasks: [], catId: 'opus' });
    const featureDoc = result.find((a) => a.type === 'feature-doc');
    const plan = result.find((a) => a.type === 'plan');
    const file = result.find((a) => a.type === 'file');
    assert.ok(featureDoc, 'should classify docs/features/ as feature-doc');
    assert.ok(plan, 'should classify docs/plans/ as plan');
    assert.ok(file, 'should classify other paths as file');
  });
});

describe('formatNavigationHeader with artifacts', () => {
  it('includes artifacts section when present', () => {
    const header = formatNavigationHeader({
      baton: null,
      tasks: [],
      artifacts: [
        { type: 'pr', ref: 'zts212653/cat-cafe#1292', label: 'PR #1292', updatedBy: 'opus' },
        { type: 'file', ref: 'packages/api/src/routes/callbacks.ts', label: 'callbacks.ts', updatedBy: 'codex' },
      ],
    });
    assert.ok(header.includes('产物'), 'should include artifacts section header');
    assert.ok(header.includes('#1292'), 'should include PR ref');
    assert.ok(header.includes('callbacks.ts'), 'should include file label');
  });

  it('omits artifacts section when empty', () => {
    const header = formatNavigationHeader({ baton: null, tasks: [], artifacts: [] });
    assert.ok(!header.includes('产物'), 'should not include artifacts section when empty');
    assert.ok(header.includes('[导航]'), 'should still have navigation wrapper');
  });

  it('omits artifacts section when undefined', () => {
    const header = formatNavigationHeader({ baton: null, tasks: [] });
    assert.ok(!header.includes('产物'));
  });
});

describe('sortAndCapArtifacts (P2-2: merge sort)', () => {
  it('sorts mixed PR + file artifacts by updatedAt DESC', () => {
    const now = Date.now();
    const mixed = [
      { type: 'pr', ref: 'org/repo#10', label: 'PR #10', updatedAt: now - 60_000, updatedBy: 'opus' },
      { type: 'file', ref: 'src/newer.ts', label: 'newer.ts', updatedAt: now, updatedBy: 'codex', ops: ['edit'] },
      { type: 'pr', ref: 'org/repo#20', label: 'PR #20', updatedAt: now - 30_000, updatedBy: 'opus' },
    ];
    const result = sortAndCapArtifacts(mixed);
    assert.equal(result[0].ref, 'src/newer.ts', 'newest item should be first regardless of type');
    assert.equal(result[1].ref, 'org/repo#20', 'second newest next');
    assert.equal(result[2].ref, 'org/repo#10', 'oldest last');
  });

  it('caps at default max (5)', () => {
    const now = Date.now();
    const items = Array.from({ length: 8 }, (_, i) => ({
      type: 'file',
      ref: `file-${i}.ts`,
      label: `file-${i}.ts`,
      updatedAt: now - i * 1000,
      updatedBy: 'opus',
    }));
    const result = sortAndCapArtifacts(items);
    assert.equal(result.length, 5);
    assert.equal(result[0].ref, 'file-0.ts', 'most recent kept');
    assert.equal(result[4].ref, 'file-4.ts', 'fifth most recent is last');
  });
});

describe('buildBriefingMessage with artifacts (AC-H4)', () => {
  const baseCoverage = {
    burst: { count: 5, timeRange: { from: 1000, to: 2000 } },
    omitted: { count: 10, participants: ['opus'], timeRange: { from: 500, to: 1000 } },
    anchorIds: [],
    retrievalHints: [],
    threadMemory: null,
  };

  it('includes artifact section in bodyMarkdown when recentArtifacts provided', () => {
    const msg = buildBriefingMessage(baseCoverage, 'thread-1', {
      recentArtifacts: [
        { type: 'pr', ref: 'zts212653/cat-cafe#1293', label: 'PR #1293', updatedAt: Date.now(), updatedBy: 'opus' },
        {
          type: 'file',
          ref: 'src/index.ts',
          label: 'index.ts',
          updatedAt: Date.now(),
          updatedBy: 'codex',
          ops: ['edit'],
        },
      ],
    });
    const body = msg.extra?.rich?.blocks?.[0]?.bodyMarkdown ?? '';
    assert.ok(body.includes('产物'), 'should include artifacts header');
    assert.ok(body.includes('PR #1293'), 'should include PR label');
    assert.ok(body.includes('index.ts'), 'should include file label');
  });

  it('omits artifact section when recentArtifacts is empty', () => {
    const msg = buildBriefingMessage(baseCoverage, 'thread-1', {
      recentArtifacts: [],
    });
    const body = msg.extra?.rich?.blocks?.[0]?.bodyMarkdown ?? '';
    assert.ok(!body.includes('产物'), 'should not include artifacts when empty');
  });

  it('omits artifact section when recentArtifacts is undefined', () => {
    const msg = buildBriefingMessage(baseCoverage, 'thread-1', {});
    const body = msg.extra?.rich?.blocks?.[0]?.bodyMarkdown ?? '';
    assert.ok(!body.includes('产物'));
  });
});
