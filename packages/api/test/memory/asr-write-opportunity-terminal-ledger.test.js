import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f276-write-opportunity-terminal-test:';
const LINEAGE_A = `write_lineage_${'a'.repeat(32)}`;
const LINEAGE_B = `write_lineage_${'b'.repeat(32)}`;

describe('RedisWriteOpportunityTerminalLedger', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisWriteOpportunityTerminalLedger;
  let WriteOpportunityTerminalKeys;
  let createRedisClient;
  let redis;
  let ledger;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisWriteOpportunityTerminalLedger');
    ({ RedisWriteOpportunityTerminalLedger } = await import(
      '../../dist/domains/memory/people/RedisWriteOpportunityTerminalLedger.js'
    ));
    ({ WriteOpportunityTerminalKeys } = await import(
      '../../dist/domains/memory/people/write-opportunity-terminal-redis-contract.js'
    ));
    ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    ledger = new RedisWriteOpportunityTerminalLedger(redis);
  });

  it('records a terminal generation and reads it back per lineage', async () => {
    await ledger.recordTerminal({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      generation: 1,
      outcome: 'defer',
      recordedAt: 1_000,
    });

    const states = await ledger.readLineageStates('owner-1', [LINEAGE_A]);
    const state = states.get(LINEAGE_A);
    assert.equal(state.invalidatedReason, undefined);
    assert.equal(state.terminalGenerations.get(1), 'defer');
    // Generation 2 is the post-defer re-arm; it must stay admissible.
    assert.equal(state.terminalGenerations.has(2), false);
  });

  it('keeps terminal state owner-scoped', async () => {
    await ledger.recordTerminal({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      generation: 1,
      outcome: 'propose',
      recordedAt: 1_000,
    });

    const other = await ledger.readLineageStates('owner-2', [LINEAGE_A]);
    assert.equal(other.get(LINEAGE_A).terminalGenerations.size, 0);
    assert.equal(other.get(LINEAGE_A).invalidatedReason, undefined);
  });

  it('tracks generations of one lineage independently', async () => {
    await ledger.recordTerminal({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      generation: 1,
      outcome: 'defer',
      recordedAt: 1_000,
    });
    await ledger.recordTerminal({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      generation: 2,
      outcome: 'propose',
      recordedAt: 2_000,
    });

    const state = (await ledger.readLineageStates('owner-1', [LINEAGE_A])).get(LINEAGE_A);
    assert.equal(state.terminalGenerations.get(1), 'defer');
    assert.equal(state.terminalGenerations.get(2), 'propose');
  });

  it('invalidates the whole lineage, not just the recorded generation', async () => {
    await ledger.recordTerminal({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      generation: 1,
      outcome: 'defer',
      recordedAt: 1_000,
    });
    await ledger.recordInvalidated({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      reason: 'source_forgotten',
      recordedAt: 3_000,
    });

    const state = (await ledger.readLineageStates('owner-1', [LINEAGE_A])).get(LINEAGE_A);
    assert.equal(state.invalidatedReason, 'source_forgotten');
  });

  it('treats invalidation as absorbing so a later terminal cannot revive the lineage', async () => {
    await ledger.recordInvalidated({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      reason: 'scope_revoked',
      recordedAt: 3_000,
    });
    await ledger.recordTerminal({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      generation: 9,
      outcome: 'propose',
      recordedAt: 4_000,
    });
    await ledger.recordInvalidated({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      reason: 'source_corrected',
      recordedAt: 5_000,
    });

    const state = (await ledger.readLineageStates('owner-1', [LINEAGE_A])).get(LINEAGE_A);
    // First invalidation wins; a later reason must not overwrite the original cause.
    assert.equal(state.invalidatedReason, 'scope_revoked');
  });

  it('reads many lineages in one pass and defaults unknown lineages to empty', async () => {
    await ledger.recordTerminal({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      generation: 1,
      outcome: 'abstain',
      recordedAt: 1_000,
    });

    const states = await ledger.readLineageStates('owner-1', [LINEAGE_A, LINEAGE_B]);
    assert.equal(states.get(LINEAGE_A).terminalGenerations.get(1), 'abstain');
    assert.equal(states.get(LINEAGE_B).terminalGenerations.size, 0);
    assert.equal(states.get(LINEAGE_B).invalidatedReason, undefined);
  });

  it('persists with no TTL because owner-visible lineage truth must survive restart', async () => {
    await ledger.recordTerminal({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      generation: 1,
      outcome: 'defer',
      recordedAt: 1_000,
    });

    const ttl = await redis.pttl(WriteOpportunityTerminalKeys.lineage('owner-1', LINEAGE_A));
    assert.equal(ttl, -1);
  });

  it('is idempotent for a replayed identical terminal record', async () => {
    const input = {
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      generation: 1,
      outcome: 'defer',
      recordedAt: 1_000,
    };
    await ledger.recordTerminal(input);
    await ledger.recordTerminal(input);

    const state = (await ledger.readLineageStates('owner-1', [LINEAGE_A])).get(LINEAGE_A);
    assert.equal(state.terminalGenerations.size, 1);
    assert.equal(state.terminalGenerations.get(1), 'defer');
  });

  it('refuses to record a conflicting outcome for an already-terminal generation', async () => {
    await ledger.recordTerminal({
      ownerUserId: 'owner-1',
      dedupeLineage: LINEAGE_A,
      generation: 1,
      outcome: 'defer',
      recordedAt: 1_000,
    });

    await assert.rejects(
      () =>
        ledger.recordTerminal({
          ownerUserId: 'owner-1',
          dedupeLineage: LINEAGE_A,
          generation: 1,
          outcome: 'propose',
          recordedAt: 2_000,
        }),
      /terminal_outcome_conflict/,
    );

    const state = (await ledger.readLineageStates('owner-1', [LINEAGE_A])).get(LINEAGE_A);
    assert.equal(state.terminalGenerations.get(1), 'defer');
  });

  it('rejects generations outside the shared uint32 contract before writing Redis', async () => {
    for (const generation of [0, 0x1_0000_0000]) {
      await assert.rejects(
        () =>
          ledger.recordTerminal({
            ownerUserId: 'owner-1',
            dedupeLineage: LINEAGE_A,
            generation,
            outcome: 'expired',
            recordedAt: 2_000,
          }),
        /generation must be a positive uint32/,
      );
    }

    assert.equal(await redis.exists(WriteOpportunityTerminalKeys.lineage('owner-1', LINEAGE_A)), 0);
  });
});
