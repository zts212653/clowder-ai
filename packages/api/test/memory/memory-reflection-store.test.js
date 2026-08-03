import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { MemoryReflectionStore } from '../../dist/domains/memory/MemoryReflectionStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { CURRENT_SCHEMA_VERSION } from '../../dist/domains/memory/schema.js';

async function createStores() {
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  return { evidence, reflection: new MemoryReflectionStore(evidence) };
}

function delta(overrides = {}) {
  return {
    kind: 'correction',
    destination: 'public_evidence',
    normalizedClaim: 'candidate 必须 pull 可见、push 收敛',
    reason: 'The owner explicitly corrected the candidate contract.',
    sourceRef: {
      threadId: 'thread-source',
      sessionId: 'session-source',
      eventNo: 12,
      invocationId: 'inv-source',
    },
    ...overrides,
  };
}

function batch(outputs, overrides = {}) {
  return {
    ownerUserId: 'owner-1',
    catId: 'codex-sol',
    householdLocalDate: '2026-07-20',
    createdAt: '2026-07-20T12:00:00.000Z',
    budget: 5,
    outputs,
    ...overrides,
  };
}

describe('F271 MemoryReflectionStore', () => {
  test('schema V34 atomically accepts a public ledger row and its pull-only evidence projection', async () => {
    const { evidence, reflection } = await createStores();
    assert.equal(CURRENT_SCHEMA_VERSION, 37);

    const result = await reflection.acceptBatch(batch([delta()]));
    assert.equal(result.accepted.length, 1);
    assert.equal(result.duplicates.length, 0);
    assert.equal(result.rejected.length, 0);

    const row = result.accepted[0];
    assert.equal(row.projectionState, 'delivered');
    assert.equal(row.destination, 'public_evidence');
    assert.equal(await reflection.countAccepted('owner-1', '2026-07-20'), 1);

    const projected = await evidence.getByAnchor(row.projectionRef);
    assert.ok(projected);
    assert.equal(projected.authority, 'candidate');
    assert.equal(projected.activation, 'pull_only');
    assert.equal(projected.summary, delta().normalizedClaim);
    assert.deepEqual(projected.drillDown, {
      tool: 'cat_cafe_read_session_events',
      params: { sessionId: 'session-source', cursor: '12', limit: '1', view: 'chat' },
      hint: 'Open the exact sealed transcript event that produced this reflection candidate.',
    });
  });

  test('rolls back the budget ledger when the public projection cannot commit', async () => {
    const { evidence, reflection } = await createStores();
    evidence.getDb().exec(`
      CREATE TRIGGER reject_f271_projection
      BEFORE INSERT ON evidence_docs
      WHEN NEW.anchor LIKE 'reflection-candidate:%'
      BEGIN
        SELECT RAISE(ABORT, 'projection rejected');
      END;
    `);

    await assert.rejects(() => reflection.acceptBatch(batch([delta()])), /projection rejected/);
    assert.equal(await reflection.countAccepted('owner-1', '2026-07-20'), 0);
    assert.equal(await evidence.getByAnchor('reflection-candidate:anything'), null);
  });

  test('projects typed decisions as F152-compatible decision candidates without auto-marking them generalizable', async () => {
    const { evidence, reflection } = await createStores();

    const result = await reflection.acceptBatch(
      batch([
        delta({
          kind: 'decision',
          normalizedClaim: '耐久真相必须先物化再编译进全局索引',
          reason: 'The owner selected the durable compiler path.',
        }),
      ]),
    );

    const projected = await evidence.getByAnchor(result.accepted[0].projectionRef);
    assert.equal(projected?.kind, 'decision');
    assert.equal(projected?.authority, 'candidate');
    assert.equal(projected?.activation, 'pull_only');
    assert.equal(projected?.generalizable, undefined);
  });

  test('persists the day ledger and drill-down projection across a database reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f271-reflection-'));
    const dbPath = join(dir, 'evidence.sqlite');
    let evidence = new SqliteEvidenceStore(dbPath);
    try {
      await evidence.initialize();
      const first = new MemoryReflectionStore(evidence);
      const accepted = await first.acceptBatch(batch([delta()]));
      const projectionRef = accepted.accepted[0].projectionRef;
      evidence.close();

      evidence = new SqliteEvidenceStore(dbPath);
      await evidence.initialize();
      const reopened = new MemoryReflectionStore(evidence);
      assert.equal(await reopened.countAccepted('owner-1', '2026-07-20'), 1);
      const projected = await evidence.getByAnchor(projectionRef);
      assert.equal(projected?.activation, 'pull_only');
      assert.equal(projected?.drillDown?.params.eventNo, undefined);
      assert.equal(projected?.drillDown?.params.cursor, '12');
    } finally {
      evidence.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deduplicates replay and the same normalized claim before charging the budget', async () => {
    const { reflection } = await createStores();
    const first = await reflection.acceptBatch(batch([delta()]));
    const replay = await reflection.acceptBatch(batch([delta()]));
    const laterSource = await reflection.acceptBatch(
      batch([
        delta({
          sourceRef: { threadId: 'thread-later', sessionId: 'session-later', eventNo: 4 },
        }),
      ]),
    );

    assert.equal(first.accepted.length, 1);
    assert.equal(replay.duplicates.length, 1);
    assert.equal(laterSource.duplicates.length, 1);
    assert.equal(await reflection.countAccepted('owner-1', '2026-07-20'), 1);
  });

  test('persists a hard owner-local-day ceiling and treats an empty batch as healthy', async () => {
    const { reflection } = await createStores();
    const outputs = Array.from({ length: 6 }, (_, index) =>
      delta({
        normalizedClaim: `unique correction ${index}`,
        sourceRef: { threadId: 'thread-source', sessionId: 'session-source', eventNo: index },
      }),
    );

    const result = await reflection.acceptBatch(batch(outputs));
    assert.equal(result.accepted.length, 5);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason, 'budget_exhausted');
    assert.equal(await reflection.countAccepted('owner-1', '2026-07-20'), 5);

    const quiet = await reflection.acceptBatch(batch([]));
    assert.deepEqual(quiet, { accepted: [], duplicates: [], rejected: [] });
    assert.equal(await reflection.countAccepted('owner-1', '2026-07-20'), 5);
  });

  test('isolates budget claims by owner and household-local day, including a zero budget', async () => {
    const { reflection } = await createStores();
    const zero = await reflection.acceptBatch(batch([delta()], { budget: 0 }));
    assert.equal(zero.accepted.length, 0);
    assert.equal(zero.rejected.length, 1);

    const ownerOne = await reflection.acceptBatch(batch([delta()], { budget: 1 }));
    const ownerTwo = await reflection.acceptBatch(
      batch([delta({ normalizedClaim: 'owner two claim' })], { ownerUserId: 'owner-2', budget: 1 }),
    );
    const nextDay = await reflection.acceptBatch(
      batch([delta({ normalizedClaim: 'next day claim' })], { householdLocalDate: '2026-07-21', budget: 1 }),
    );

    assert.equal(ownerOne.accepted.length, 1);
    assert.equal(ownerTwo.accepted.length, 1);
    assert.equal(nextDay.accepted.length, 1);
    assert.equal(await reflection.countAccepted('owner-1', '2026-07-20'), 1);
    assert.equal(await reflection.countAccepted('owner-2', '2026-07-20'), 1);
    assert.equal(await reflection.countAccepted('owner-1', '2026-07-21'), 1);
  });

  test('serializes concurrent claims when only one budget slot remains', async () => {
    const { reflection } = await createStores();
    const [left, right] = await Promise.all([
      reflection.acceptBatch(batch([delta({ normalizedClaim: 'left claim' })], { budget: 1 })),
      reflection.acceptBatch(
        batch([delta({ normalizedClaim: 'right claim', sourceRef: { threadId: 't2', sessionId: 's2', eventNo: 2 } })], {
          budget: 1,
        }),
      ),
    ]);

    assert.equal(left.accepted.length + right.accepted.length, 1);
    assert.equal(left.rejected.length + right.rejected.length, 1);
    assert.equal(await reflection.countAccepted('owner-1', '2026-07-20'), 1);
  });

  test('keeps private cues pending until an idempotent F255 acknowledgement', async () => {
    const { reflection, evidence } = await createStores();
    const privateDelta = delta({
      kind: 'desire_cue',
      destination: 'f255_private_cue',
      normalizedClaim: '我想要一个可以巡逻的身体',
      targetCatId: 'codex-sol',
    });

    const result = await reflection.acceptBatch(batch([privateDelta]));
    assert.equal(result.accepted[0].projectionState, 'pending');
    assert.equal(result.accepted[0].projectionRef, undefined);
    assert.equal(await evidence.getByAnchor(`reflection-candidate:${result.accepted[0].outputId}`), null);

    const pending = await reflection.listPendingCues('owner-1', 'codex-sol');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].outputId, result.accepted[0].outputId);
    assert.deepEqual(await reflection.listPendingCues('owner-1', 'other-cat'), []);
    assert.deepEqual(await reflection.listPendingCues('other-owner', 'codex-sol'), []);
    await assert.rejects(
      () =>
        reflection.markCueDelivered(
          pending[0].outputId,
          'other-owner',
          'codex-sol',
          'f255-cue:wrong-scope',
          '2026-07-20T12:00:30.000Z',
        ),
      /owner\/cat scope/,
    );
    assert.equal(
      (await reflection.listPendingCues('owner-1', 'codex-sol'))[0].normalizedClaim,
      privateDelta.normalizedClaim,
    );

    const delivered = await reflection.markCueDelivered(
      pending[0].outputId,
      'owner-1',
      'codex-sol',
      'f255-cue:stable-ref',
      '2026-07-20T12:01:00.000Z',
    );
    assert.equal(delivered.projectionState, 'delivered');
    assert.equal(delivered.projectionRef, 'f255-cue:stable-ref');

    const replayAck = await reflection.markCueDelivered(
      pending[0].outputId,
      'owner-1',
      'codex-sol',
      'f255-cue:stable-ref',
      '2026-07-20T12:02:00.000Z',
    );
    assert.deepEqual(replayAck, delivered);
    assert.deepEqual(await reflection.listPendingCues('owner-1', 'codex-sol'), []);

    const deliveredRow = evidence
      .getDb()
      .prepare(
        `SELECT normalized_claim, reason, claim_fingerprint
         FROM reflection_outputs WHERE output_id = ?`,
      )
      .get(pending[0].outputId);
    assert.equal(deliveredRow.normalized_claim, null);
    assert.equal(deliveredRow.reason, null);
    assert.match(deliveredRow.claim_fingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(deliveredRow.claim_fingerprint, privateDelta.normalizedClaim);

    const laterReplay = await reflection.acceptBatch(
      batch([
        {
          ...privateDelta,
          sourceRef: { threadId: 'thread-later', sessionId: 'session-later', eventNo: 9 },
        },
      ]),
    );
    assert.equal(laterReplay.accepted.length, 0);
    assert.equal(laterReplay.duplicates.length, 1);
    assert.equal(await reflection.countAccepted('owner-1', '2026-07-20'), 1);
  });

  test('scopes pending private payload reads by both owner and cat', async () => {
    const { reflection } = await createStores();
    const ownerOne = delta({
      kind: 'desire_cue',
      destination: 'f255_private_cue',
      normalizedClaim: '我想要 owner one 的私人线索',
      targetCatId: 'cat-one',
    });
    const ownerTwo = delta({
      kind: 'desire_cue',
      destination: 'f255_private_cue',
      normalizedClaim: '我想要 owner two 的私人线索',
      targetCatId: 'cat-two',
    });

    await reflection.acceptBatch(batch([ownerOne], { ownerUserId: 'owner-one', catId: 'cat-one' }));
    await reflection.acceptBatch(batch([ownerTwo], { ownerUserId: 'owner-two', catId: 'cat-two' }));

    const one = await reflection.listPendingCues('owner-one', 'cat-one');
    const two = await reflection.listPendingCues('owner-two', 'cat-two');
    assert.equal(one.length, 1);
    assert.equal(two.length, 1);
    assert.equal(one[0].normalizedClaim, ownerOne.normalizedClaim);
    assert.equal(two[0].normalizedClaim, ownerTwo.normalizedClaim);
    assert.deepEqual(await reflection.listPendingCues('owner-one', 'cat-two'), []);
    assert.deepEqual(await reflection.listPendingCues('owner-two', 'cat-one'), []);
  });
});
