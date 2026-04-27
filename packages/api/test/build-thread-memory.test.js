import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildThreadMemory } from '../dist/domains/cats/services/session/buildThreadMemory.js';

describe('buildThreadMemory', () => {
  const baseDigest = {
    v: 1,
    sessionId: 's1',
    threadId: 't1',
    catId: 'opus',
    seq: 0,
    time: { createdAt: 1000000, sealedAt: 1060000 },
    invocations: [{ toolNames: ['Edit', 'Read', 'Grep'] }],
    filesTouched: [{ path: 'src/index.ts', ops: ['edit'] }],
    errors: [],
  };

  it('creates new memory from null + digest', () => {
    const result = buildThreadMemory(null, baseDigest, 1500);
    assert.equal(result.v, 1);
    assert.equal(result.sessionsIncorporated, 1);
    assert.ok(result.summary.includes('Session #1'));
    assert.ok(result.summary.includes('Modified: src/index.ts'));
  });

  it('appends to existing memory', () => {
    const existing = {
      v: 1,
      summary: 'Session #1 (00:16-00:17, 1min): Edit, Read. Files: src/a.ts.',
      sessionsIncorporated: 1,
      updatedAt: 1000,
    };
    const digest2 = { ...baseDigest, seq: 1, sessionId: 's2' };
    const result = buildThreadMemory(existing, digest2, 1500);
    assert.equal(result.sessionsIncorporated, 2);
    assert.ok(result.summary.includes('Session #2'));
    assert.ok(result.summary.includes('Session #1'));
  });

  it('trims oldest sessions when exceeding maxTokens', () => {
    let mem = null;
    for (let i = 0; i < 20; i++) {
      const d = {
        ...baseDigest,
        seq: i,
        sessionId: `s${i}`,
        invocations: [
          {
            toolNames: Array.from({ length: 10 }, (_, j) => `Tool${j}_${'x'.repeat(20)}`),
          },
        ],
        filesTouched: Array.from({ length: 10 }, (_, j) => ({
          path: `src/deep/module-${j}.ts`,
          ops: ['edit'],
        })),
      };
      mem = buildThreadMemory(mem, d, 500); // low cap to force trimming
    }
    assert.ok(mem);
    assert.ok(mem.summary.includes('Session #20')); // newest kept
    assert.equal(mem.summary.includes('Session #1 '), false); // oldest trimmed
  });

  it('includes error count when digest has errors', () => {
    const digestWithErrors = {
      ...baseDigest,
      errors: [{ at: 1050000, message: 'TypeError: foo' }],
    };
    const result = buildThreadMemory(null, digestWithErrors, 1500);
    assert.ok(result.summary.includes('1 error'));
  });

  it('caps tools at 10 and files at 10', () => {
    const bigDigest = {
      ...baseDigest,
      invocations: [{ toolNames: Array.from({ length: 20 }, (_, i) => `Tool${i}`) }],
      filesTouched: Array.from({ length: 20 }, (_, i) => ({
        path: `f${i}.ts`,
        ops: ['edit'],
      })),
    };
    const result = buildThreadMemory(null, bigDigest, 1500);
    // Should mention "+N more" for overflow
    assert.ok(result.summary.includes('+'));
  });

  it('returns v:1 with correct updatedAt', () => {
    const before = Date.now();
    const result = buildThreadMemory(null, baseDigest, 1500);
    assert.ok(result.updatedAt >= before);
  });

  it('handles digest with no toolNames gracefully', () => {
    const noToolsDigest = {
      ...baseDigest,
      invocations: [{ invocationId: 'inv1' }], // no toolNames
    };
    const result = buildThreadMemory(null, noToolsDigest, 1500);
    assert.equal(result.v, 1);
    assert.ok(result.summary.includes('Session #1'));
  });

  it('hard-caps single line that exceeds maxTokens', () => {
    const hugeDigest = {
      ...baseDigest,
      invocations: [
        {
          toolNames: Array.from({ length: 10 }, (_, i) => `VeryLongToolName_${'z'.repeat(100)}_${i}`),
        },
      ],
      filesTouched: Array.from({ length: 10 }, (_, i) => ({
        path: `src/very/deep/nested/directory/structure/module-${i}-with-long-name.ts`,
        ops: ['edit'],
      })),
    };
    // Very low cap — single line will exceed it
    const result = buildThreadMemory(null, hugeDigest, 50);
    assert.equal(result.v, 1);
    assert.ok(result.summary.endsWith('...'));
  });

  // R1 P1-1: session number must use digest.seq, not sessionsIncorporated
  it('uses digest.seq for session number (late-start thread)', () => {
    // Thread already on session #5 (seq=4), but no ThreadMemory yet
    const lateDigest = { ...baseDigest, seq: 4, sessionId: 's5' };
    const result = buildThreadMemory(null, lateDigest, 1500);
    // Should show "Session #5" (seq 4 → 1-based = 5), NOT "Session #1"
    assert.ok(result.summary.includes('Session #5'), `Expected "Session #5" but got: ${result.summary}`);
    assert.equal(result.summary.includes('Session #1'), false);
    // sessionsIncorporated tracks how many digests have been merged
    assert.equal(result.sessionsIncorporated, 1);
  });

  it('uses digest.seq for accumulated sessions', () => {
    // Existing memory from session #3, now sealing session #5 (seq=4)
    const existing = {
      v: 1,
      summary: 'Session #3 (10:00-10:05, 5min): Modified: a.ts.',
      sessionsIncorporated: 1,
      updatedAt: 1000,
    };
    const digest5 = { ...baseDigest, seq: 4, sessionId: 's5' };
    const result = buildThreadMemory(existing, digest5, 1500);
    assert.ok(result.summary.includes('Session #5'), `Expected "Session #5" but got: ${result.summary}`);
    assert.equal(result.sessionsIncorporated, 2); // 2 digests merged
  });
});

// --- Phase D: AC-D1 — Product-oriented formatSessionLine ---

describe('Phase D: product-oriented formatSessionLine (AC-D1)', () => {
  const mkDigest = (filesTouched, extra = {}) => ({
    v: 1,
    sessionId: 's-d1',
    threadId: 't-d1',
    catId: 'opus',
    seq: 0,
    time: { createdAt: 1000000, sealedAt: 1060000 },
    invocations: [{ toolNames: ['Edit'] }],
    filesTouched,
    errors: [],
    ...extra,
  });

  it('groups files under "Created" for create ops', () => {
    const digest = mkDigest([{ path: 'src/new.ts', ops: ['create'] }]);
    const result = buildThreadMemory(null, digest, 1500);
    assert.ok(result.summary.includes('Created: src/new.ts'), `Expected "Created: src/new.ts" in: ${result.summary}`);
  });

  it('groups files under "Modified" for edit ops', () => {
    const digest = mkDigest([{ path: 'routes.ts', ops: ['edit'] }]);
    const result = buildThreadMemory(null, digest, 1500);
    assert.ok(result.summary.includes('Modified: routes.ts'), `Expected "Modified: routes.ts" in: ${result.summary}`);
  });

  it('groups files under "Read" for read ops', () => {
    const digest = mkDigest([{ path: 'index.ts', ops: ['read'] }]);
    const result = buildThreadMemory(null, digest, 1500);
    assert.ok(result.summary.includes('Read: index.ts'), `Expected "Read: index.ts" in: ${result.summary}`);
  });

  it('groups files under "Deleted" for delete ops', () => {
    const digest = mkDigest([{ path: 'old.ts', ops: ['delete'] }]);
    const result = buildThreadMemory(null, digest, 1500);
    assert.ok(result.summary.includes('Deleted: old.ts'), `Expected "Deleted: old.ts" in: ${result.summary}`);
  });

  it('file with multiple ops goes under highest-priority (create > edit > delete > read)', () => {
    const digest = mkDigest([{ path: 'src/config.ts', ops: ['read', 'edit'] }]);
    const result = buildThreadMemory(null, digest, 1500);
    // Should show under Modified (edit > read)
    assert.ok(result.summary.includes('Modified: src/config.ts'), `Expected under Modified: ${result.summary}`);
    // Should NOT duplicate under Read
    assert.ok(!result.summary.includes('Read: src/config.ts'), `Should not also appear under Read: ${result.summary}`);
  });

  it('mixed ops across files produce multiple groups', () => {
    const digest = mkDigest([
      { path: 'src/new.ts', ops: ['create'] },
      { path: 'routes.ts', ops: ['edit'] },
      { path: 'index.ts', ops: ['read'] },
    ]);
    const result = buildThreadMemory(null, digest, 1500);
    assert.ok(result.summary.includes('Created: src/new.ts'), `Missing Created: ${result.summary}`);
    assert.ok(result.summary.includes('Modified: routes.ts'), `Missing Modified: ${result.summary}`);
    assert.ok(result.summary.includes('Read: index.ts'), `Missing Read: ${result.summary}`);
  });

  it('does NOT include raw tools line', () => {
    const digest = mkDigest([{ path: 'src/index.ts', ops: ['edit'] }], {
      invocations: [{ toolNames: ['Edit', 'Read', 'Grep'] }],
    });
    const result = buildThreadMemory(null, digest, 1500);
    // Old format had "Edit, Read, Grep. Files:" — new format should not have this
    assert.ok(!result.summary.includes('Edit, Read'), `Should not contain tools list: ${result.summary}`);
    assert.ok(!result.summary.includes('Files:'), `Should not contain "Files:": ${result.summary}`);
  });

  it('files with empty ops are omitted from output', () => {
    const digest = mkDigest([{ path: 'src/unknown.ts', ops: [] }]);
    const result = buildThreadMemory(null, digest, 1500);
    // File with no ops shouldn't appear (no category to put it in)
    assert.ok(!result.summary.includes('src/unknown.ts'), `Empty-ops file should be omitted: ${result.summary}`);
  });

  it('caps at MAX_FILES_DISPLAY per category with +N more', () => {
    const files = Array.from({ length: 15 }, (_, i) => ({
      path: `src/mod-${i}.ts`,
      ops: ['edit'],
    }));
    const digest = mkDigest(files);
    const result = buildThreadMemory(null, digest, 1500);
    assert.ok(result.summary.includes('+'), `Should show overflow indicator: ${result.summary}`);
  });
});

// --- VG-3: Decision signals in buildThreadMemory ---

describe('VG-3: buildThreadMemory with DecisionSignals', () => {
  const baseDigest = {
    v: 1,
    sessionId: 's1',
    threadId: 't1',
    catId: 'opus',
    seq: 0,
    time: { createdAt: 1000000, sealedAt: 1060000 },
    invocations: [],
    filesTouched: [],
    errors: [],
  };

  it('merges decisions from signals into threadMemory', () => {
    const signals = {
      decisions: ['用方案B'],
      openQuestions: ['gap阈值?'],
      artifacts: ['ADR-011'],
    };
    const result = buildThreadMemory(null, baseDigest, 3000, signals);
    assert.deepStrictEqual(result.decisions, ['用方案B']);
    assert.deepStrictEqual(result.openQuestions, ['gap阈值?']);
    assert.deepStrictEqual(result.artifacts, ['ADR-011']);
  });

  it('accumulates decisions across sessions', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: 1000,
      decisions: ['用方案A'],
      openQuestions: ['端口?'],
      artifacts: ['F148'],
    };
    const signals = {
      decisions: ['改用方案B'],
      openQuestions: ['gap阈值?'],
      artifacts: ['ADR-011'],
    };
    const digest2 = { ...baseDigest, seq: 1 };
    const result = buildThreadMemory(existing, digest2, 3000, signals);
    assert.ok(result.decisions?.includes('改用方案B'), 'new decisions appear');
    assert.ok(result.decisions?.includes('用方案A'), 'old decisions preserved');
    assert.ok(result.openQuestions?.includes('gap阈值?'));
    assert.ok(result.artifacts?.includes('ADR-011'));
    assert.ok(result.artifacts?.includes('F148'));
  });

  it('backward compatible — no signals = no decision fields', () => {
    const result = buildThreadMemory(null, baseDigest, 3000);
    assert.strictEqual(result.decisions, undefined);
    assert.strictEqual(result.openQuestions, undefined);
    assert.strictEqual(result.artifacts, undefined);
  });

  it('caps at max limits', () => {
    const signals = {
      decisions: Array.from({ length: 12 }, (_, i) => `决策${i}`),
      openQuestions: Array.from({ length: 8 }, (_, i) => `问题${i}`),
      artifacts: Array.from({ length: 12 }, (_, i) => `ADR-${i}`),
    };
    const result = buildThreadMemory(null, baseDigest, 3000, signals);
    assert.ok((result.decisions?.length ?? 0) <= 8);
    assert.ok((result.openQuestions?.length ?? 0) <= 5);
    assert.ok((result.artifacts?.length ?? 0) <= 8);
  });

  it('cloud-R2-P1: malformed carry-forward (non-array with .length) is ignored', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: Date.now(),
      decisions: { length: 1, 0: 'x' }, // array-like object, not a real array
      openQuestions: 'bad-string', // string has .length but isn't array
      artifacts: 42, // number, no .length
    };
    // Must not throw — malformed fields should be ignored
    const result = buildThreadMemory(existing, { ...baseDigest, seq: 1 }, 3000, undefined);
    assert.strictEqual(result.decisions, undefined, 'non-array decisions must be ignored');
    assert.strictEqual(result.openQuestions, undefined, 'non-array openQuestions must be ignored');
    assert.strictEqual(result.artifacts, undefined, 'non-array artifacts must be ignored');
  });

  it('cloud-P2: carry-forward applies max caps on existing oversized arrays', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: Date.now(),
      decisions: Array.from({ length: 50 }, (_, i) => `决策${i}`),
      openQuestions: Array.from({ length: 20 }, (_, i) => `问题${i}`),
      artifacts: Array.from({ length: 30 }, (_, i) => `ADR-${i}`),
    };
    const result = buildThreadMemory(existing, { ...baseDigest, seq: 1 }, 3000, undefined);
    assert.ok((result.decisions?.length ?? 0) <= 8, `decisions should be capped at 8, got ${result.decisions?.length}`);
    assert.ok(
      (result.openQuestions?.length ?? 0) <= 5,
      `openQuestions should be capped at 5, got ${result.openQuestions?.length}`,
    );
    assert.ok((result.artifacts?.length ?? 0) <= 8, `artifacts should be capped at 8, got ${result.artifacts?.length}`);
  });

  it('P1-2: preserves existing decisions when signals is undefined', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: Date.now(),
      decisions: ['用方案A', '确定端口6398'],
      openQuestions: ['阈值待定'],
      artifacts: ['F148'],
    };
    // signals=undefined simulates extractSignals failure
    const result = buildThreadMemory(existing, { ...baseDigest, seq: 1 }, 3000, undefined);
    assert.deepStrictEqual(result.decisions, ['用方案A', '确定端口6398'], 'must preserve existing decisions');
    assert.deepStrictEqual(result.openQuestions, ['阈值待定'], 'must preserve existing openQuestions');
    assert.deepStrictEqual(result.artifacts, ['F148'], 'must preserve existing artifacts');
  });

  // AC-H2 + G1: recentArtifacts stored as ledger (sorted by updatedAt DESC)
  it('AC-H2: stores recentArtifacts when provided (sorted by updatedAt DESC)', () => {
    const artifacts = [
      { type: 'file', ref: 'src/index.ts', label: 'index.ts', updatedAt: 1000, updatedBy: 'opus', ops: ['edit'] },
      {
        type: 'feature-doc',
        ref: 'docs/features/F148.md',
        label: 'F148.md',
        updatedAt: 2000,
        updatedBy: 'opus',
        ops: ['edit'],
      },
    ];
    const result = buildThreadMemory(null, baseDigest, 3000, undefined, artifacts);
    assert.equal(result.recentArtifacts?.length, 2);
    assert.equal(result.recentArtifacts[0].ref, 'docs/features/F148.md', 'newest first');
    assert.equal(result.recentArtifacts[1].ref, 'src/index.ts', 'oldest second');
  });

  it('AC-H2 + G1: appends new artifacts to existing ledger (not overwrite)', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: Date.now(),
      recentArtifacts: [{ type: 'file', ref: 'old.ts', label: 'old.ts', updatedAt: 1000, updatedBy: 'opus' }],
    };
    const newArtifacts = [
      { type: 'file', ref: 'new.ts', label: 'new.ts', updatedAt: 2000, updatedBy: 'opus', ops: ['create'] },
    ];
    const result = buildThreadMemory(existing, { ...baseDigest, seq: 1 }, 3000, undefined, newArtifacts);
    assert.equal(result.recentArtifacts?.length, 2, 'should accumulate both entries');
    assert.equal(result.recentArtifacts?.[0].ref, 'new.ts', 'newest first');
    assert.equal(result.recentArtifacts?.[1].ref, 'old.ts', 'oldest second');
  });

  it('AC-H2: preserves existing recentArtifacts when new artifacts param is undefined', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: Date.now(),
      recentArtifacts: [{ type: 'pr', ref: 'cat-cafe#1293', label: 'PR #1293', updatedAt: 3000, updatedBy: 'codex' }],
    };
    const result = buildThreadMemory(existing, { ...baseDigest, seq: 1 }, 3000);
    assert.equal(result.recentArtifacts?.length, 1);
    assert.equal(result.recentArtifacts?.[0].ref, 'cat-cafe#1293');
  });

  it('AC-H2: backward compat — old memory without recentArtifacts produces no field', () => {
    const existing = {
      v: 1,
      summary: 'Session #1',
      sessionsIncorporated: 1,
      updatedAt: Date.now(),
    };
    const result = buildThreadMemory(existing, { ...baseDigest, seq: 1 }, 3000);
    assert.equal(result.recentArtifacts, undefined);
  });
});
