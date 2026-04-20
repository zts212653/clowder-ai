/**
 * F163: Experiment logger — records effective_flags + variant_id per search
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { F163ExperimentLogger } from '../../dist/domains/memory/f163-experiment-logger.js';
import { computeVariantId, freezeFlags } from '../../dist/domains/memory/f163-types.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

describe('F163 ExperimentLogger', () => {
  let db;
  let logger;
  let previousF163Env;

  beforeEach(() => {
    previousF163Env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('F163_')) {
        previousF163Env[key] = value;
        delete process.env[key];
      }
    }
    db = new Database(':memory:');
    applyMigrations(db);
    logger = new F163ExperimentLogger(db);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
    Object.assign(process.env, previousF163Env);
  });

  it('logSearch inserts a search log entry', () => {
    const flags = freezeFlags();
    const variantId = computeVariantId(flags);

    logger.logSearch(variantId, flags, { query: 'Redis pitfall', resultCount: 3 });

    const rows = db.prepare('SELECT * FROM f163_logs WHERE log_type = ?').all('search');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].variant_id, variantId);
    assert.equal(rows[0].log_type, 'search');

    const parsedFlags = JSON.parse(rows[0].effective_flags);
    assert.equal(parsedFlags.authorityBoost, 'off');

    const parsedPayload = JSON.parse(rows[0].payload);
    assert.equal(parsedPayload.query, 'Redis pitfall');
    assert.equal(parsedPayload.resultCount, 3);
  });

  it('logWrite inserts a write log entry', () => {
    process.env.F163_PROMOTION_GATE = 'suggest';
    const flags = freezeFlags();
    const variantId = computeVariantId(flags);

    logger.logWrite(variantId, flags, { capability: 'promotionGate', action: 'suggest' });

    const rows = db.prepare('SELECT * FROM f163_logs WHERE log_type = ?').all('write');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].log_type, 'write');

    const parsedFlags = JSON.parse(rows[0].effective_flags);
    assert.equal(parsedFlags.promotionGate, 'suggest');
  });

  it('multiple log entries are recorded', () => {
    const flags = freezeFlags();
    const vid = computeVariantId(flags);

    logger.logSearch(vid, flags, { query: 'q1' });
    logger.logSearch(vid, flags, { query: 'q2' });
    logger.logWrite(vid, flags, { capability: 'test' });

    const count = db.prepare('SELECT count(*) AS c FROM f163_logs').get();
    assert.equal(count.c, 3);
  });
});
