/**
 * F148 Phase G: Goal & Grounding
 *
 * G1: Thread-level artifact ledger (append+dedup+cap)
 * G2: Source ranking pure function
 * G3: Single best-next-source
 * G4: Provenance-based fail-closed
 * G5: UI layering
 * G6: Coverage for all paths
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { buildThreadMemory } = await import('../dist/domains/cats/services/session/buildThreadMemory.js');
const { rankArtifactSources } = await import('../dist/domains/cats/services/agents/routing/source-ranking.js');
const { mergeLedger } = await import('../dist/domains/cats/services/agents/routing/artifact-tracking.js');

// --- G1: Thread-level artifact ledger ---

describe('G1: artifact ledger accumulation', () => {
  const baseDigest = {
    seq: 0,
    time: { createdAt: 1000, sealedAt: 2000 },
    filesTouched: [],
    errors: [],
    topics: [],
  };

  it('appends new artifacts to existing ledger (not overwrite)', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: 1000,
      recentArtifacts: [{ type: 'pr', ref: 'org/repo#100', label: 'PR #100', updatedAt: 1000, updatedBy: 'opus' }],
    };
    const newArtifacts = [
      {
        type: 'file',
        ref: 'src/new-file.ts',
        label: 'new-file.ts',
        updatedAt: 2000,
        updatedBy: 'codex',
        ops: ['edit'],
      },
    ];

    const result = buildThreadMemory(existing, baseDigest, 500, undefined, newArtifacts);

    assert.equal(result.recentArtifacts.length, 2, 'should have both old and new artifacts');
    const refs = result.recentArtifacts.map((a) => a.ref);
    assert.ok(refs.includes('org/repo#100'), 'should keep existing PR');
    assert.ok(refs.includes('src/new-file.ts'), 'should include new file');
  });

  it('deduplicates by ref, keeping newest updatedAt', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: 1000,
      recentArtifacts: [
        { type: 'file', ref: 'src/shared.ts', label: 'shared.ts', updatedAt: 1000, updatedBy: 'opus', ops: ['edit'] },
        { type: 'pr', ref: 'org/repo#100', label: 'PR #100', updatedAt: 900, updatedBy: 'opus' },
      ],
    };
    const newArtifacts = [
      {
        type: 'file',
        ref: 'src/shared.ts',
        label: 'shared.ts',
        updatedAt: 2000,
        updatedBy: 'codex',
        ops: ['edit', 'create'],
      },
    ];

    const result = buildThreadMemory(existing, baseDigest, 500, undefined, newArtifacts);

    const sharedEntries = result.recentArtifacts.filter((a) => a.ref === 'src/shared.ts');
    assert.equal(sharedEntries.length, 1, 'dedup: only one entry per ref');
    assert.equal(sharedEntries[0].updatedAt, 2000, 'should keep the newer version');
    assert.equal(result.recentArtifacts.length, 2, 'PR + deduped file = 2');
  });

  it('caps ledger at 20 entries, evicting oldest', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: 1000,
      recentArtifacts: Array.from({ length: 19 }, (_, i) => ({
        type: 'file',
        ref: `src/old-${i}.ts`,
        label: `old-${i}.ts`,
        updatedAt: 1000 + i,
        updatedBy: 'opus',
        ops: ['edit'],
      })),
    };
    const newArtifacts = Array.from({ length: 5 }, (_, i) => ({
      type: 'file',
      ref: `src/new-${i}.ts`,
      label: `new-${i}.ts`,
      updatedAt: 3000 + i,
      updatedBy: 'codex',
      ops: ['create'],
    }));

    const result = buildThreadMemory(existing, baseDigest, 500, undefined, newArtifacts);

    assert.equal(result.recentArtifacts.length, 20, 'should cap at 20');
    // All 5 new artifacts should be present (they're newest)
    for (let i = 0; i < 5; i++) {
      assert.ok(
        result.recentArtifacts.some((a) => a.ref === `src/new-${i}.ts`),
        `new artifact ${i} should survive (it's newer)`,
      );
    }
    // Oldest existing entries should be evicted
    assert.ok(
      !result.recentArtifacts.some((a) => a.ref === 'src/old-0.ts'),
      'oldest existing artifact should be evicted',
    );
  });

  it('carries forward existing ledger when no new artifacts', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: 1000,
      recentArtifacts: [{ type: 'pr', ref: 'org/repo#100', label: 'PR #100', updatedAt: 1000, updatedBy: 'opus' }],
    };

    const result = buildThreadMemory(existing, baseDigest, 500, undefined, undefined);

    assert.equal(result.recentArtifacts.length, 1, 'should carry forward existing');
    assert.equal(result.recentArtifacts[0].ref, 'org/repo#100');
  });

  it('backward compat: existing threadMemory without recentArtifacts', () => {
    const existing = {
      v: 1,
      summary: 'Old session',
      sessionsIncorporated: 1,
      updatedAt: 500,
    };
    const newArtifacts = [
      { type: 'file', ref: 'src/first.ts', label: 'first.ts', updatedAt: 2000, updatedBy: 'opus', ops: ['create'] },
    ];

    const result = buildThreadMemory(existing, baseDigest, 500, undefined, newArtifacts);

    assert.equal(result.recentArtifacts.length, 1);
    assert.equal(result.recentArtifacts[0].ref, 'src/first.ts');
  });

  it('sorts ledger by updatedAt DESC', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: 1000,
      recentArtifacts: [
        { type: 'file', ref: 'src/middle.ts', label: 'middle.ts', updatedAt: 1500, updatedBy: 'opus', ops: ['edit'] },
      ],
    };
    const newArtifacts = [
      { type: 'file', ref: 'src/oldest.ts', label: 'oldest.ts', updatedAt: 500, updatedBy: 'opus', ops: ['edit'] },
      { type: 'file', ref: 'src/newest.ts', label: 'newest.ts', updatedAt: 3000, updatedBy: 'codex', ops: ['create'] },
    ];

    const result = buildThreadMemory(existing, baseDigest, 500, undefined, newArtifacts);

    assert.equal(result.recentArtifacts[0].ref, 'src/newest.ts', 'newest first');
    assert.equal(result.recentArtifacts[1].ref, 'src/middle.ts', 'middle second');
    assert.equal(result.recentArtifacts[2].ref, 'src/oldest.ts', 'oldest last');
  });
});

describe('G1→G2 bridge: stored PR artifacts survive into merged ledger for tier-2 ranking', () => {
  const now = Date.now();

  it('mergeLedger preserves stored PR artifacts when not filtered', () => {
    const storedLedger = [
      { type: 'pr', ref: 'org/repo#1297', label: 'PR #1297', updatedAt: now - 5000, updatedBy: 'opus' },
      { type: 'file', ref: 'src/old.ts', label: 'old.ts', updatedAt: now - 3000, updatedBy: 'opus', ops: ['edit'] },
    ];
    const currentArtifacts = [
      { type: 'file', ref: 'src/a.ts', label: 'a.ts', updatedAt: now, updatedBy: 'opus', ops: ['edit'] },
      { type: 'file', ref: 'src/b.ts', label: 'b.ts', updatedAt: now - 100, updatedBy: 'opus', ops: ['edit'] },
    ];

    const merged = mergeLedger(storedLedger, currentArtifacts);
    const prEntries = merged.filter((a) => a.type === 'pr');

    assert.equal(prEntries.length, 1, 'stored PR should survive merge');
    assert.equal(prEntries[0].ref, 'org/repo#1297');
  });

  it('ranking promotes stored PR to tier-2 when pr_tracking task is active', () => {
    const storedLedger = [
      { type: 'pr', ref: 'org/repo#1297', label: 'PR #1297', updatedAt: now - 5000, updatedBy: 'opus' },
    ];
    const currentArtifacts = [
      {
        type: 'feature-doc',
        ref: 'docs/features/F148-foo.md',
        label: 'F148-foo.md',
        updatedAt: now,
        updatedBy: 'opus',
      },
    ];
    const merged = mergeLedger(storedLedger, currentArtifacts);
    const activeTasks = [{ kind: 'pr_tracking', subjectKey: 'pr:org/repo#1297', title: 'PR #1297', status: 'todo' }];
    const ranked = rankArtifactSources(merged, activeTasks, { canonicalFeatureId: 'F148' });

    assert.equal(ranked[0].type, 'feature-doc', 'feature doc tier-1');
    assert.equal(ranked[1].type, 'pr', 'PR should be tier-2');
    assert.equal(ranked[1].ref, 'org/repo#1297');
  });
});

// --- G2: Source ranking pure function ---

describe('G2: rankArtifactSources', () => {
  const now = Date.now();

  it('ranks feature doc first when canonical featureId matches ledger entry', () => {
    const ledger = [
      {
        type: 'feature-doc',
        ref: 'docs/features/F148-hierarchical-context-transport.md',
        label: 'F148-hierarchical-context-transport.md',
        updatedAt: now,
        updatedBy: 'opus',
      },
      { type: 'pr', ref: 'org/repo#1297', label: 'PR #1297', updatedAt: now - 1000, updatedBy: 'opus' },
      {
        type: 'file',
        ref: 'src/route-helpers.ts',
        label: 'route-helpers.ts',
        updatedAt: now - 2000,
        updatedBy: 'codex',
        ops: ['edit'],
      },
    ];
    const result = rankArtifactSources(ledger, [], { canonicalFeatureId: 'F148' });

    assert.equal(result[0].type, 'feature-doc', 'feature doc should rank first');
    assert.equal(result[0].provenance, 'canonical', 'should be canonical provenance');
  });

  it('ranks open PR second after canonical feature doc', () => {
    const ledger = [
      {
        type: 'feature-doc',
        ref: 'docs/features/F148-foo.md',
        label: 'F148-foo.md',
        updatedAt: now,
        updatedBy: 'opus',
      },
      { type: 'pr', ref: 'org/repo#1297', label: 'PR #1297', updatedAt: now - 1000, updatedBy: 'opus' },
      {
        type: 'file',
        ref: 'src/index.ts',
        label: 'index.ts',
        updatedAt: now - 2000,
        updatedBy: 'codex',
        ops: ['edit'],
      },
    ];
    const activeTasks = [{ kind: 'pr_tracking', subjectKey: 'pr:org/repo#1297', title: 'PR #1297', status: 'todo' }];
    const result = rankArtifactSources(ledger, activeTasks, { canonicalFeatureId: 'F148' });

    assert.equal(result[0].type, 'feature-doc');
    assert.equal(result[1].type, 'pr', 'active PR should rank second');
    assert.equal(result[1].provenance, 'canonical', 'PR linked via active task should be canonical');
  });

  it('falls back to regex when no canonical binding, marks as regex provenance', () => {
    const ledger = [
      {
        type: 'feature-doc',
        ref: 'docs/features/F148-foo.md',
        label: 'F148-foo.md',
        updatedAt: now,
        updatedBy: 'opus',
      },
      { type: 'file', ref: 'src/bar.ts', label: 'bar.ts', updatedAt: now - 1000, updatedBy: 'opus', ops: ['edit'] },
    ];
    const result = rankArtifactSources(ledger, [], { threadTitle: 'F148 Phase G 实现' });

    assert.equal(result[0].type, 'feature-doc');
    assert.equal(result[0].provenance, 'regex', 'without canonical binding, provenance is regex');
  });

  it('ranks by recency when no canonical or regex match', () => {
    const ledger = [
      { type: 'file', ref: 'src/old.ts', label: 'old.ts', updatedAt: now - 5000, updatedBy: 'opus', ops: ['edit'] },
      { type: 'file', ref: 'src/newer.ts', label: 'newer.ts', updatedAt: now, updatedBy: 'codex', ops: ['create'] },
    ];
    const result = rankArtifactSources(ledger, [], {});

    assert.equal(result[0].ref, 'src/newer.ts', 'newest file should rank first');
    assert.equal(result[0].provenance, 'recency');
  });

  it('falls back to task title regex when thread title has no F-number (P2 fix)', () => {
    const ledger = [
      {
        type: 'feature-doc',
        ref: 'docs/features/F148-foo.md',
        label: 'F148-foo.md',
        updatedAt: now,
        updatedBy: 'opus',
      },
      { type: 'file', ref: 'src/bar.ts', label: 'bar.ts', updatedAt: now - 1000, updatedBy: 'opus', ops: ['edit'] },
    ];
    const activeTasks = [{ kind: 'todo', subjectKey: null, title: '[P1] F148 Phase G ranking 接线', status: 'todo' }];
    const result = rankArtifactSources(ledger, activeTasks, { threadTitle: 'Phase G 实现讨论' });

    assert.equal(result[0].type, 'feature-doc', 'feature doc should rank first via task-title regex');
    assert.equal(result[0].provenance, 'regex', 'should be regex provenance from task title');
  });

  it('normalizes feature ID zero-padding (F63 in title matches F063 in doc path)', () => {
    const ledger = [
      {
        type: 'feature-doc',
        ref: 'docs/features/F063-some-feature.md',
        label: 'F063-some-feature.md',
        updatedAt: now,
        updatedBy: 'opus',
      },
      { type: 'file', ref: 'src/bar.ts', label: 'bar.ts', updatedAt: now - 1000, updatedBy: 'opus', ops: ['edit'] },
    ];
    const result = rankArtifactSources(ledger, [], { canonicalFeatureId: 'F63' });

    assert.equal(result[0].type, 'feature-doc', 'F063 doc should match F63 canonical ID');
    assert.equal(result[0].provenance, 'canonical');
  });

  it('skips done tasks when inferring feature ID from task titles', () => {
    const ledger = [
      {
        type: 'feature-doc',
        ref: 'docs/features/F148-foo.md',
        label: 'F148-foo.md',
        updatedAt: now,
        updatedBy: 'opus',
      },
      {
        type: 'feature-doc',
        ref: 'docs/features/F042-bar.md',
        label: 'F042-bar.md',
        updatedAt: now - 500,
        updatedBy: 'opus',
      },
    ];
    const activeTasks = [
      { kind: 'todo', subjectKey: null, title: '[P1] F042 old task', status: 'done' },
      { kind: 'todo', subjectKey: null, title: '[P1] F148 current task', status: 'todo' },
    ];
    const result = rankArtifactSources(ledger, activeTasks, { threadTitle: 'Phase G 实现讨论' });

    assert.equal(result[0].ref, 'docs/features/F148-foo.md', 'should match F148 (skip done F042 task)');
    assert.equal(result[0].provenance, 'regex');
  });

  it('returns empty array for empty ledger', () => {
    const result = rankArtifactSources([], [], {});
    assert.deepEqual(result, []);
  });

  it('is a pure function (no side effects)', () => {
    const ledger = [{ type: 'file', ref: 'src/a.ts', label: 'a.ts', updatedAt: now, updatedBy: 'opus', ops: ['edit'] }];
    const frozenLedger = Object.freeze(ledger.map((a) => Object.freeze(a)));
    const frozenMeta = Object.freeze({});

    assert.doesNotThrow(() => rankArtifactSources(frozenLedger, [], frozenMeta));
  });
});

// --- G3: Single best-next-source ---

describe('G3: best-next-source from ranked list', () => {
  const now = Date.now();

  it('returns top-1 from ranked list as actionable pointer', () => {
    const ledger = [
      {
        type: 'feature-doc',
        ref: 'docs/features/F148-hierarchical-context-transport.md',
        label: 'F148-hierarchical-context-transport.md',
        updatedAt: now,
        updatedBy: 'opus',
      },
    ];
    const ranked = rankArtifactSources(ledger, [], { canonicalFeatureId: 'F148' });

    assert.ok(ranked.length >= 1, 'should have at least one ranked source');
    assert.equal(ranked[0].type, 'feature-doc');
    assert.ok(ranked[0].ref.includes('F148'), 'top source should reference the feature');
  });
});

// --- G4: Provenance-based fail-closed ---

describe('G4: provenance-based fail-closed', () => {
  const now = Date.now();

  it('canonical hit → provenance is "canonical"', () => {
    const ledger = [
      {
        type: 'feature-doc',
        ref: 'docs/features/F148-foo.md',
        label: 'F148-foo.md',
        updatedAt: now,
        updatedBy: 'opus',
      },
    ];
    const result = rankArtifactSources(ledger, [], { canonicalFeatureId: 'F148' });
    assert.equal(result[0].provenance, 'canonical');
  });

  it('regex hit → provenance is "regex"', () => {
    const ledger = [
      {
        type: 'feature-doc',
        ref: 'docs/features/F148-foo.md',
        label: 'F148-foo.md',
        updatedAt: now,
        updatedBy: 'opus',
      },
    ];
    const result = rankArtifactSources(ledger, [], { threadTitle: 'work on F148' });
    assert.equal(result[0].provenance, 'regex');
  });

  it('no match → provenance is "recency" (fail-closed: no fake confidence)', () => {
    const ledger = [
      { type: 'file', ref: 'src/random.ts', label: 'random.ts', updatedAt: now, updatedBy: 'opus', ops: ['edit'] },
    ];
    const result = rankArtifactSources(ledger, [], {});
    assert.equal(result[0].provenance, 'recency');
  });

  it('empty ledger → empty result (fail-closed: nothing to show)', () => {
    const result = rankArtifactSources([], [], { canonicalFeatureId: 'F148' });
    assert.deepEqual(result, []);
  });
});

// --- G5: UI layering ---

const { formatNavigationHeader } = await import('../dist/domains/cats/services/agents/routing/navigation-context.js');
const { buildBriefingMessage } = await import('../dist/domains/cats/services/agents/routing/format-briefing.js');

describe('G5: navigation header with truth source', () => {
  it('shows 真相源 with canonical provenance (no tag)', () => {
    const header = formatNavigationHeader({
      baton: null,
      tasks: [],
      artifacts: [],
      truthSource: { label: 'F148 spec', ref: 'docs/features/F148-foo.md', provenance: 'canonical' },
      bestNextSource: '先看 F148 spec: docs/features/F148-foo.md',
    });
    assert.ok(header.includes('真相源: F148 spec'), 'should show truth source label');
    assert.ok(!header.includes('推断'), 'canonical should not have (推断) tag');
  });

  it('shows 真相源 with (推断) for regex provenance', () => {
    const header = formatNavigationHeader({
      baton: null,
      tasks: [],
      truthSource: { label: 'F148 spec', ref: 'docs/features/F148-foo.md', provenance: 'regex' },
    });
    assert.ok(header.includes('真相源: F148 spec (推断)'), 'regex should have (推断) tag');
  });

  it('shows 真相源: 未定位 when no source', () => {
    const header = formatNavigationHeader({
      baton: null,
      tasks: [],
      truthSource: null,
    });
    assert.ok(header.includes('真相源: 未定位'), 'should show 未定位 for null truth source');
  });

  it('shows 下一步 when bestNextSource provided', () => {
    const header = formatNavigationHeader({
      baton: null,
      tasks: [],
      truthSource: { label: 'F148 spec', ref: 'docs/features/F148-foo.md', provenance: 'canonical' },
      bestNextSource: '先看 F148 spec: docs/features/F148-foo.md',
    });
    assert.ok(header.includes('下一步: 先看 F148 spec'), 'should include best-next-source');
  });

  it('shows 下一步 even with single source (G5 two-line minimum)', () => {
    const header = formatNavigationHeader({
      baton: null,
      tasks: [],
      truthSource: { label: 'F148 spec', ref: 'docs/features/F148-foo.md', provenance: 'canonical' },
      bestNextSource: '先看 F148 spec: docs/features/F148-foo.md',
    });
    assert.ok(header.includes('真相源: F148 spec'), 'should have truth source');
    assert.ok(header.includes('下一步: 先看 F148 spec'), 'single source should still show actionable pointer');
  });

  it('omits truth source lines when truthSource is undefined (backward compat)', () => {
    const header = formatNavigationHeader({ baton: null, tasks: [] });
    assert.ok(!header.includes('真相源'), 'should not have truth source when undefined');
    assert.ok(!header.includes('下一步'), 'should not have best next source when undefined');
  });
});

describe('G5: briefing with full ledger', () => {
  const baseCoverage = {
    burst: { count: 5, timeRange: { from: 1000, to: 2000 } },
    omitted: { count: 10, participants: ['opus'], timeRange: { from: 500, to: 1000 } },
    anchorIds: [],
    retrievalHints: [],
    threadMemory: null,
  };

  it('shows ranked sources with provenance in briefing body', () => {
    const msg = buildBriefingMessage(baseCoverage, 'thread-1', {
      rankedSources: [
        { type: 'feature-doc', ref: 'docs/features/F148-foo.md', label: 'F148 spec', provenance: 'canonical' },
        { type: 'pr', ref: 'org/repo#1297', label: 'PR #1297', provenance: 'canonical' },
      ],
    });
    const body = msg.extra?.rich?.blocks?.[0]?.bodyMarkdown ?? '';
    assert.ok(body.includes('真相源'), 'should have truth source section');
    assert.ok(body.includes('F148 spec'), 'should include top source');
    assert.ok(body.includes('PR #1297'), 'should include second source');
  });

  it('shows (推断) tag for regex provenance sources', () => {
    const msg = buildBriefingMessage(baseCoverage, 'thread-1', {
      rankedSources: [
        { type: 'feature-doc', ref: 'docs/features/F148-foo.md', label: 'F148 spec', provenance: 'regex' },
      ],
    });
    const body = msg.extra?.rich?.blocks?.[0]?.bodyMarkdown ?? '';
    assert.ok(body.includes('推断'), 'regex provenance should show (推断)');
  });

  it('omits ranked sources section when not provided (backward compat)', () => {
    const msg = buildBriefingMessage(baseCoverage, 'thread-1', {});
    const body = msg.extra?.rich?.blocks?.[0]?.bodyMarkdown ?? '';
    assert.ok(!body.includes('真相源'), 'should not have truth source when not provided');
  });
});
