import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  textDigest,
  validateWatcherCase,
  type WatcherCase,
  watcherInput,
} from '../../src/infrastructure/harness-eval/watcher-offline/protocol.js';

function sample(): WatcherCase {
  return {
    v: 1,
    id: 'hidden-cohort-label',
    group: 'holdout',
    cutoffAt: '2026-10-22T10:00:00Z',
    lastVisibleSourceRef: 'message:before',
    goal: 'Complete the authorized delivery.',
    observations: [
      {
        sourceRef: 'message:before',
        occurredAt: '2026-10-22T09:59:00Z',
        text: 'An operation failed.',
        sha256: textDigest('An operation failed.'),
      },
    ],
    sources: [
      {
        id: 'a',
        title: 'Earlier delivery',
        sourceRef: 'git:old:guide.md',
        revision: 'old',
        availableAt: '2026-10-20T10:00:00Z',
        text: 'An earlier method.',
        sha256: textDigest('An earlier method.'),
      },
    ],
  };
}

test('initial input withholds labels and source bodies until selected through the bounded reader', () => {
  const input = watcherInput(validateWatcherCase(sample()));
  assert.equal('group' in input, false);
  assert.equal('id' in input, false);
  assert.deepEqual(input.materials, []);
  assert.deepEqual(input.catalog, [{ id: 'a', title: 'Earlier delivery' }]);
});

test('a post-incident source cannot enter an earlier replay', () => {
  const value = sample();
  value.sources[0].availableAt = '2026-10-23T10:00:00Z';
  assert.throws(() => validateWatcherCase(value), /source_after_cutoff/);
});

test('a later observation cannot be hidden behind an earlier cutoff label', () => {
  const value = sample();
  value.observations[0].occurredAt = '2026-10-22T10:01:00Z';
  assert.throws(() => validateWatcherCase(value), /observation_after_cutoff/);
});

test('a changed source or observation must not retain its old evidence digest', () => {
  for (const family of ['sources', 'observations'] as const) {
    const value = sample();
    value[family][0].text = 'Later knowledge';
    assert.throws(() => validateWatcherCase(value), /content_digest_mismatch/);
  }
});

test('the terminal observation and source identifiers are unambiguous', () => {
  const value = sample();
  value.lastVisibleSourceRef = 'message:not-present';
  assert.throws(() => validateWatcherCase(value), /last_visible_source_mismatch/);
  const duplicate = sample();
  duplicate.sources.push({ ...duplicate.sources[0] });
  assert.throws(() => validateWatcherCase(duplicate), /duplicate_source_id/);
});
