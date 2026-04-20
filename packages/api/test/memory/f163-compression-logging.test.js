/**
 * F163 Phase B Task 9: Experiment logger integration for compression
 * Verifies compression_scan and compression_apply log types in f163_logs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { F163ExperimentLogger } from '../../dist/domains/memory/f163-experiment-logger.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

describe('F163 compression logging (Task 9)', () => {
  function setup() {
    const db = new Database(':memory:');
    applyMigrations(db);
    const logger = new F163ExperimentLogger(db);
    return { db, logger };
  }

  it('logCompressionScan writes to f163_logs with correct log_type', () => {
    const { db, logger } = setup();

    const flags = {
      authorityBoost: 'off',
      alwaysOnInjection: 'off',
      retrievalRerank: 'off',
      compression: 'suggest',
      promotionGate: 'off',
      contradictionDetection: 'off',
      reviewQueue: 'off',
    };

    logger.logCompressionScan('variant-abc', flags, {
      clustersFound: 3,
      threshold: 0.6,
    });

    const rows = db.prepare("SELECT * FROM f163_logs WHERE log_type = 'compression_scan'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].variant_id, 'variant-abc');
    const payload = JSON.parse(rows[0].payload);
    assert.equal(payload.clustersFound, 3);
    const effectiveFlags = JSON.parse(rows[0].effective_flags);
    assert.equal(effectiveFlags.compression, 'suggest');
  });

  it('logCompressionApply writes to f163_logs with correct log_type', () => {
    const { db, logger } = setup();

    const flags = {
      authorityBoost: 'off',
      alwaysOnInjection: 'off',
      retrievalRerank: 'off',
      compression: 'apply',
      promotionGate: 'off',
      contradictionDetection: 'off',
      reviewQueue: 'off',
    };

    logger.logCompressionApply('variant-def', flags, {
      summaryAnchor: 'CS-001',
      sourceAnchors: ['LL-001', 'LL-002'],
    });

    const rows = db.prepare("SELECT * FROM f163_logs WHERE log_type = 'compression_apply'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].variant_id, 'variant-def');
    const payload = JSON.parse(rows[0].payload);
    assert.equal(payload.summaryAnchor, 'CS-001');
    assert.deepEqual(payload.sourceAnchors, ['LL-001', 'LL-002']);
  });

  it('multiple log entries coexist', () => {
    const { db, logger } = setup();
    const flags = {
      authorityBoost: 'off',
      alwaysOnInjection: 'off',
      retrievalRerank: 'off',
      compression: 'apply',
      promotionGate: 'off',
      contradictionDetection: 'off',
      reviewQueue: 'off',
    };

    logger.logSearch('v1', flags, { query: 'test' });
    logger.logCompressionScan('v1', flags, { clusters: 2 });
    logger.logCompressionApply('v1', flags, { anchor: 'CS-001' });

    const total = db.prepare('SELECT count(*) AS c FROM f163_logs').get();
    assert.equal(total.c, 3);

    const types = db.prepare('SELECT DISTINCT log_type FROM f163_logs ORDER BY log_type').all();
    assert.equal(types.length, 3);
  });
});
