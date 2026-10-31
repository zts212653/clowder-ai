/**
 * F188 Phase K — Task 1 TDD red
 *
 * Tests for `packages/api/src/domains/memory/evidence-status-signals.ts`:
 *   - 5 detectors × pass/fail conditions
 *   - docs_root_suspicious covers 4 status paths per plan R4
 *   - evaluator aggregation
 *   - functionalStatus derivation
 *
 * Per plan Task 1 — file imports compiled dist (project test convention).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

const NONEXISTENT_ROOT = '/var/tmp/cat-cafe-f188-phase-k-nonexistent-xyz123';

function makeSignals(overrides = {}) {
  return {
    dbCounts: {
      docs_count: 0,
      edges_count: 0,
      vectors_count: 0,
      passage_vectors_count: 0,
      threads_count: 0,
      passages_count: 0,
      ...(overrides.dbCounts ?? {}),
    },
    embeddingMeta: {
      embedding_model: 'cl100k_base',
      ...(overrides.embeddingMeta ?? {}),
    },
    embeddingService: {
      passage_vectors_supported: true,
      ...(overrides.embeddingService ?? {}),
    },
    catalogSnapshot: {
      collections: overrides.catalogSnapshot?.collections ?? [],
    },
  };
}

function makeCollection(overrides = {}) {
  return {
    id: 'project:test',
    root: NONEXISTENT_ROOT,
    kind: 'project',
    status: 'active',
    ...overrides,
  };
}

describe('evidence-status-signals (F188 Phase K)', () => {
  let mod;
  let existingNonEmptyRoot;

  before(async () => {
    mod = await import('../../dist/domains/memory/evidence-status-signals.js');
    existingNonEmptyRoot = mkdtempSync(join(tmpdir(), 'f188-phase-k-existing-'));
    writeFileSync(join(existingNonEmptyRoot, 'sentinel.md'), '# sentinel\n');
  });

  // -------- detectDocsRootSuspicious — 4 status paths per plan R4 --------

  describe('detectDocsRootSuspicious — status filter (plan R4: filter !== archived)', () => {
    it('active + missing root → warn', () => {
      const signals = makeSignals({
        catalogSnapshot: {
          collections: [makeCollection({ status: 'active', root: NONEXISTENT_ROOT })],
        },
      });
      const warning = mod.detectDocsRootSuspicious(signals);
      assert.ok(warning, 'expected ConfigWarning, got null');
      assert.equal(warning.code, 'docs_root_suspicious');
      assert.ok(warning.message);
      assert.ok(warning.suggestedAction);
    });

    it('stale + missing root → warn (stale still participates)', () => {
      const signals = makeSignals({
        catalogSnapshot: {
          collections: [makeCollection({ status: 'stale', root: NONEXISTENT_ROOT })],
        },
      });
      const warning = mod.detectDocsRootSuspicious(signals);
      assert.ok(warning, 'expected ConfigWarning for stale + missing');
      assert.equal(warning.code, 'docs_root_suspicious');
    });

    it('archived + missing root → no warn (archived is skipped)', () => {
      const signals = makeSignals({
        catalogSnapshot: {
          collections: [makeCollection({ status: 'archived', root: NONEXISTENT_ROOT })],
        },
      });
      const warning = mod.detectDocsRootSuspicious(signals);
      assert.equal(warning, null, 'archived collections should not trigger docs_root_suspicious');
    });

    it('status undefined (defaults to active) + missing root → warn', () => {
      const collection = makeCollection({ root: NONEXISTENT_ROOT });
      delete collection.status;
      const signals = makeSignals({
        catalogSnapshot: { collections: [collection] },
      });
      const warning = mod.detectDocsRootSuspicious(signals);
      assert.ok(warning, 'undefined status should default to active and trigger warn');
      assert.equal(warning.code, 'docs_root_suspicious');
    });

    it('existing non-empty root → no warn', () => {
      const signals = makeSignals({
        catalogSnapshot: {
          collections: [makeCollection({ status: 'active', root: existingNonEmptyRoot })],
        },
      });
      const warning = mod.detectDocsRootSuspicious(signals);
      assert.equal(warning, null, 'real non-empty root should not trigger warn');
    });
  });

  // -------- detectEmbeddingDisabled --------

  describe('detectEmbeddingDisabled', () => {
    it('embedding_model === null → warn', () => {
      const signals = makeSignals({ embeddingMeta: { embedding_model: null } });
      const warning = mod.detectEmbeddingDisabled(signals);
      assert.ok(warning, 'null embedding_model should warn');
      assert.equal(warning.code, 'embedding_disabled');
      assert.ok(warning.suggestedAction);
      assert.match(warning.suggestedAction, /local embedding service/i);
      assert.doesNotMatch(warning.suggestedAction, /OPENAI_EMBEDDING_API_KEY/);
    });

    it('embedding_model set → no warn', () => {
      const signals = makeSignals({ embeddingMeta: { embedding_model: 'cl100k_base' } });
      assert.equal(mod.detectEmbeddingDisabled(signals), null);
    });
  });

  // -------- detectVectorsEmpty --------

  describe('detectVectorsEmpty', () => {
    it('vectors_count === 0 && docs_count > 0 → warn', () => {
      const signals = makeSignals({ dbCounts: { docs_count: 10, vectors_count: 0 } });
      const warning = mod.detectVectorsEmpty(signals);
      assert.ok(warning);
      assert.equal(warning.code, 'vectors_empty');
    });

    it('vectors_count > 0 → no warn', () => {
      const signals = makeSignals({ dbCounts: { docs_count: 10, vectors_count: 5 } });
      assert.equal(mod.detectVectorsEmpty(signals), null);
    });

    it('docs_count === 0 → no warn (nothing to vector yet)', () => {
      const signals = makeSignals({ dbCounts: { docs_count: 0, vectors_count: 0 } });
      assert.equal(mod.detectVectorsEmpty(signals), null);
    });
  });

  // -------- detectGraphEmpty --------

  describe('detectGraphEmpty', () => {
    it('edges_count === 0 && docs_count > 0 → warn', () => {
      const signals = makeSignals({ dbCounts: { docs_count: 10, edges_count: 0 } });
      const warning = mod.detectGraphEmpty(signals);
      assert.ok(warning);
      assert.equal(warning.code, 'graph_empty');
    });

    it('edges_count > 0 → no warn', () => {
      const signals = makeSignals({ dbCounts: { docs_count: 10, edges_count: 3 } });
      assert.equal(mod.detectGraphEmpty(signals), null);
    });
  });

  // -------- detectVecTableMissing --------

  describe('detectVecTableMissing', () => {
    it('passage_vectors_supported === false → warn', () => {
      const signals = makeSignals({ embeddingService: { passage_vectors_supported: false } });
      const warning = mod.detectVecTableMissing(signals);
      assert.ok(warning);
      assert.equal(warning.code, 'vec_table_missing');
      assert.match(warning.suggestedAction, /embedding service/i);
      assert.doesNotMatch(warning.suggestedAction, /OPENAI_EMBEDDING_API_KEY/);
    });

    it('passage_vectors_supported === true → no warn', () => {
      const signals = makeSignals({ embeddingService: { passage_vectors_supported: true } });
      assert.equal(mod.detectVecTableMissing(signals), null);
    });
  });

  // -------- evaluateConfigWarnings — aggregator --------

  describe('evaluateConfigWarnings (multi-warning aggregate)', () => {
    it('reporter #880 fixture → 3+ warnings + functionalStatus=degraded', () => {
      // Reporter #880 state: healthy=true but everything半瘫
      const signals = makeSignals({
        dbCounts: { docs_count: 10, edges_count: 0, vectors_count: 0, passage_vectors_count: 0 },
        embeddingMeta: { embedding_model: null },
        embeddingService: { passage_vectors_supported: false },
        catalogSnapshot: { collections: [] },
      });
      const warnings = mod.evaluateConfigWarnings(signals);
      assert.ok(Array.isArray(warnings), 'evaluateConfigWarnings returns array');
      assert.ok(warnings.length >= 3, `expected >=3 warnings, got ${warnings.length}`);
      const codes = warnings.map((w) => w.code);
      assert.ok(codes.includes('vectors_empty'));
      assert.ok(codes.includes('graph_empty'));
      assert.ok(codes.includes('embedding_disabled'));
    });

    it('healthy config (no detectors trigger) → 0 warnings', () => {
      const signals = makeSignals({
        dbCounts: { docs_count: 10, edges_count: 5, vectors_count: 5, passage_vectors_count: 5 },
        embeddingMeta: { embedding_model: 'cl100k_base' },
        embeddingService: { passage_vectors_supported: true },
        catalogSnapshot: {
          collections: [makeCollection({ status: 'active', root: existingNonEmptyRoot })],
        },
      });
      const warnings = mod.evaluateConfigWarnings(signals);
      assert.equal(warnings.length, 0);
    });
  });

  // -------- computeFunctionalStatus — length-based --------

  describe('computeFunctionalStatus', () => {
    it('0 warnings → ok', () => {
      assert.equal(mod.computeFunctionalStatus([]), 'ok');
    });

    it('>=1 warning → degraded', () => {
      const warnings = [{ code: 'vectors_empty', message: 'x', suggestedAction: 'y' }];
      assert.equal(mod.computeFunctionalStatus(warnings), 'degraded');
    });
  });
});
