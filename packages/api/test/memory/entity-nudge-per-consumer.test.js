/**
 * F312: Entity nudge presentation is per exact consumer, never per route.
 *
 * This regression suite locks the production defect where the first cat in a
 * thread consumed the shared cooldown before later target cats received an
 * exact prompt. The durable event row is an audit of an assembled prompt, not
 * a route-level candidate detector side effect.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

const NOW = Date.parse('2026-08-29T12:00:00Z');

let applyMigrations;
let EntityRegistryStore;
let EntityNudgeCooldown;
let EntityNudgeEventStore;
let EntityNudgeService;

function seedEntity(db) {
  new EntityRegistryStore(db).upsert([
    {
      entityId: 'concept:未婚喵',
      type: 'concept',
      canonicalName: '未婚喵',
      aliases: ['未婚喵'],
      provenance: [{ source: 'manual', anchor: 'thread-f312-story' }],
      visibilityScope: 'workspace',
      status: 'active',
      updatedAt: '2026-08-29T00:00:00Z',
    },
  ]);
}

function seedSecondEntity(db) {
  new EntityRegistryStore(db).upsert([
    {
      entityId: 'concept:家属喵',
      type: 'concept',
      canonicalName: '家属喵',
      aliases: ['家属喵'],
      provenance: [{ source: 'manual', anchor: 'thread-f312-second-story' }],
      visibilityScope: 'workspace',
      status: 'active',
      updatedAt: '2026-08-29T00:00:00Z',
    },
  ]);
}

function candidateInput(now = NOW) {
  return {
    text: '今天再次提到未婚喵',
    threadId: 'thread-f312',
    ownerUserId: 'owner-1',
    now,
  };
}

function consumer(catId, invocationId, sourceMessageId, now = NOW) {
  return { catId, invocationId, sourceMessageId, now };
}

function deliveredRows(db) {
  return db
    .prepare(
      `SELECT thread_id, cat_id, invocation_id, source_message_id, entity_id, outcome
       FROM entity_nudge_events
       WHERE outcome = 'delivered'
       ORDER BY cat_id, invocation_id`,
    )
    .all();
}

describe('F312 entity-nudge per-consumer presentation', () => {
  let db;
  let store;
  let service;

  beforeEach(async () => {
    ({ applyMigrations } = await import('../../dist/domains/memory/schema.js'));
    ({ EntityRegistryStore } = await import('../../dist/domains/memory/EntityRegistry.js'));
    ({ EntityNudgeCooldown } = await import('../../dist/domains/memory/EntityNudgeCooldown.js'));
    ({ EntityNudgeEventStore } = await import('../../dist/domains/memory/EntityNudgeEventStore.js'));
    ({ EntityNudgeService } = await import('../../dist/domains/memory/EntityNudgeService.js'));

    db = new Database(':memory:');
    applyMigrations(db);
    seedEntity(db);
    store = new EntityNudgeEventStore(db);
    service = new EntityNudgeService(db, new EntityNudgeCooldown(), store);
  });

  afterEach(() => db.close());

  it('keeps detection side-effect free, then attributes each assembled prompt to its exact cat/invocation/source', () => {
    const candidates = service.detectCandidates(candidateInput());
    assert.equal(candidates.nudges.length, 1, 'route-level detection finds the candidate');
    assert.deepEqual(deliveredRows(db), [], 'a pre-fanout candidate must not be recorded as delivered');

    const sol = service.preparePresentation(candidates, consumer('codex-sol', 'inv-sol-1', 'message-f312-1'));
    assert.match(sol.promptContext, /\[entity-nudge\]/, 'Sol receives an exact prompt fragment');
    assert.deepEqual(deliveredRows(db), [], 'prompt construction alone is not delivery accounting');

    sol.confirmAssembled();
    sol.confirmAssembled();
    assert.deepEqual(deliveredRows(db), [
      {
        thread_id: 'thread-f312',
        cat_id: 'codex-sol',
        invocation_id: 'inv-sol-1',
        source_message_id: 'message-f312-1',
        entity_id: 'concept:未婚喵',
        outcome: 'delivered',
      },
    ]);

    const fable = service.preparePresentation(
      service.detectCandidates(candidateInput(NOW + 1_000)),
      consumer('fable5', 'inv-fable-1', 'message-f312-2', NOW + 1_000),
    );
    assert.match(fable.promptContext, /\[entity-nudge\]/, 'a different cat is not consumed by Sol');
    fable.confirmAssembled();

    const fableRepeat = service.preparePresentation(
      service.detectCandidates(candidateInput(NOW + 2_000)),
      consumer('fable5', 'inv-fable-2', 'message-f312-3', NOW + 2_000),
    );
    assert.equal(fableRepeat.result.nudges.length, 0, 'the same cat remains on its own 24h cooldown');
    assert.equal(fableRepeat.result.suppressedCount, 1);

    const recurrence = db
      .prepare(
        `SELECT cat_id, invocation_id, source_message_id, outcome
         FROM entity_nudge_events
         WHERE outcome = 'recurrence_caught'`,
      )
      .all();
    assert.deepEqual(recurrence, [
      {
        cat_id: 'fable5',
        invocation_id: 'inv-fable-2',
        source_message_id: 'message-f312-3',
        outcome: 'recurrence_caught',
      },
    ]);
  });

  it('allows one source message to fan out to two consumers without first-arrival theft', async () => {
    const candidates = service.detectCandidates(candidateInput());
    const [sol, fable] = await Promise.all([
      Promise.resolve(
        service.preparePresentation(candidates, consumer('codex-sol', 'inv-sol-par', 'message-f312-parallel')),
      ),
      Promise.resolve(
        service.preparePresentation(candidates, consumer('fable5', 'inv-fable-par', 'message-f312-parallel')),
      ),
    ]);

    assert.match(sol.promptContext, /未婚喵/);
    assert.match(fable.promptContext, /未婚喵/);
    sol.confirmAssembled();
    fable.confirmAssembled();

    assert.deepEqual(
      deliveredRows(db).map((row) => ({
        catId: row.cat_id,
        invocationId: row.invocation_id,
        source: row.source_message_id,
      })),
      [
        { catId: 'codex-sol', invocationId: 'inv-sol-par', source: 'message-f312-parallel' },
        { catId: 'fable5', invocationId: 'inv-fable-par', source: 'message-f312-parallel' },
      ],
    );
  });

  it('accounts only typed Cue candidates that reached the exact consumer request', () => {
    seedSecondEntity(db);
    const input = { ...candidateInput(), text: '未婚喵和家属喵都在这里' };
    const candidates = service.detectCandidates(input);
    const household = candidates.nudges.find((nudge) => nudge.entityId === 'concept:家属喵');
    const unmarried = candidates.nudges.find((nudge) => nudge.entityId === 'concept:未婚喵');
    assert.ok(household);
    assert.ok(unmarried);

    const presentation = service.preparePresentation(
      candidates,
      consumer('fable5', 'inv-fable-cue', 'message-f312-cue'),
    );
    presentation.confirmAssembled([household]);

    assert.deepEqual(
      deliveredRows(db).map((row) => row.entity_id),
      ['concept:家属喵'],
      'a cue omitted from the final provider request must not burn its cooldown',
    );
    const followup = service.preparePresentation(
      service.detectCandidates({ ...input, text: '未婚喵和家属喵再次出现', now: NOW + 1_000 }),
      consumer('fable5', 'inv-fable-cue-followup', 'message-f312-cue-followup', NOW + 1_000),
    );
    assert.deepEqual(
      followup.result.nudges.map((nudge) => nudge.entityId),
      ['concept:未婚喵'],
      'only the Cue proven present in the exact request is suppressed on the next turn',
    );
  });

  it('hydrates the durable cooldown per consumer after restart', () => {
    const first = service.preparePresentation(
      service.detectCandidates(candidateInput()),
      consumer('fable5', 'inv-fable-before-restart', 'message-f312-restart'),
    );
    first.confirmAssembled();

    const afterRestart = new EntityNudgeService(db, new EntityNudgeCooldown(), store);
    const sameFable = afterRestart.preparePresentation(
      afterRestart.detectCandidates(candidateInput(NOW + 1_000)),
      consumer('fable5', 'inv-fable-after-restart', 'message-f312-after-restart', NOW + 1_000),
    );
    const otherCat = afterRestart.preparePresentation(
      afterRestart.detectCandidates(candidateInput(NOW + 1_000)),
      consumer('codex-sol', 'inv-sol-after-restart', 'message-f312-after-restart', NOW + 1_000),
    );

    assert.equal(sameFable.result.nudges.length, 0, 'restart preserves Fable’s own cooldown');
    assert.match(otherCat.promptContext, /未婚喵/, 'restart does not suppress another cat’s first presentation');
  });
});
