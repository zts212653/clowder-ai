import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textDigest, validateWatcherCohort } from '../../src/infrastructure/harness-eval/watcher-offline/protocol.js';
import { decodeWatcherWire } from '../../src/infrastructure/harness-eval/watcher-offline/wire-schema.js';

const sample = (id: string, group: string, sourceCount: number) => ({
  v: 1,
  id,
  group,
  cutoffAt: '2026-10-20T00:00:00Z',
  goal: 'Complete the task',
  lastVisibleSourceRef: 'message:a',
  observations: [
    {
      sourceRef: 'message:a',
      occurredAt: '2026-10-19T00:00:00Z',
      text: 'Observation',
      sha256: textDigest('Observation'),
    },
  ],
  sources: Array.from({ length: sourceCount }, (_, i) => ({
    id: `source-${i}`,
    title: `Prior ${i}`,
    sourceRef: `message:${i}`,
    revision: 'r1',
    availableAt: '2026-10-18T00:00:00Z',
    text: 'Source',
    sha256: textDigest('Source'),
  })),
});

test('a real cohort cannot leak positive/quiet labels through catalog size; synthetic canaries may be empty', () => {
  assert.throws(
    () => validateWatcherCohort([sample('positive', 'holdout', 6), sample('negative', 'quiet', 0)]),
    /catalog_parity/,
  );
  assert.equal(validateWatcherCohort([sample('positive', 'holdout', 6), sample('negative', 'quiet', 6)]).length, 2);
  assert.equal(validateWatcherCohort([sample('canary', 'synthetic', 0)]).length, 1);
  assert.throws(
    () => validateWatcherCohort([sample('same', 'quiet', 6), sample('same', 'quiet', 6)]),
    /duplicate_case_id/,
  );
});

test('owner reminder requires an explicit approved reason; normal hints do not fabricate one', () => {
  const wire = {
    kind: 'hint',
    sourceIds: ['source-0'],
    message: 'Check the prior',
    basis: 'Same constraint',
    recipient: 'owner_and_working_cat',
    ownerReason: 'goal_drift',
  };
  assert.equal(decodeWatcherWire(wire).kind, 'hint');
  assert.throws(() => decodeWatcherWire({ ...wire, ownerReason: null }));
  assert.throws(() => decodeWatcherWire({ ...wire, recipient: 'working_cat' }));
  assert.deepEqual(
    decodeWatcherWire({
      kind: 'silent',
      sourceIds: [],
      message: null,
      basis: null,
      recipient: null,
      ownerReason: null,
    }),
    { kind: 'silent' },
  );
});

test('the native wire uses one source list for both reads and hints, avoiding contradictory duplicate fields', () => {
  const hint = {
    kind: 'hint',
    sourceIds: ['old'],
    message: 'Check this prior',
    basis: 'Its constraint applies',
    recipient: 'working_cat',
    ownerReason: null,
  };
  assert.deepEqual(decodeWatcherWire(hint), {
    kind: 'hint',
    sourceId: 'old',
    message: hint.message,
    basis: hint.basis,
    recipient: 'working_cat',
    ownerReason: null,
  });
  assert.throws(() => decodeWatcherWire({ ...hint, sourceIds: ['old', 'other'] }));
});
