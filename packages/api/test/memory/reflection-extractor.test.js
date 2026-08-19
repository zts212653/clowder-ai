import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  DEFAULT_REFLECTION_CANDIDATE_BUDGET,
  extractReflectionDeltas,
} from '../../dist/domains/memory/reflection-extractor.js';

const replay = JSON.parse(readFileSync(new URL('../fixtures/f271-reflection-replay.json', import.meta.url), 'utf8'));

describe('F271 real-history reflection replay', () => {
  test('extracts only the expected typed deltas with their original source anchors', () => {
    let outputCount = 0;

    for (const session of replay.sessions) {
      const outputs = extractReflectionDeltas({
        catId: session.catId,
        entries: session.entries,
      });
      outputCount += outputs.length;

      assert.equal(
        outputs.length,
        session.expected.length,
        `${session.id}: unexpected outputs ${JSON.stringify(outputs)}`,
      );

      for (const expected of session.expected) {
        const output = outputs.find(
          (candidate) =>
            candidate.kind === expected.kind &&
            candidate.destination === expected.destination &&
            candidate.normalizedClaim.includes(expected.claimIncludes),
        );
        assert.ok(output, `${session.id}: missing ${JSON.stringify(expected)}`);
        assert.deepEqual(output.sourceRef, session.entries[0].sourceRef);
        assert.ok(output.reason.length > 0, `${session.id}: typed reason must be explicit`);
      }
    }

    assert.equal(outputCount, replay.expectedDailyOutputCount);
  });

  test('locks the replay-derived hard default without treating quiet capacity as a quota', () => {
    assert.equal(DEFAULT_REFLECTION_CANDIDATE_BUDGET, replay.defaultBudget);
    assert.ok(replay.expectedDailyOutputCount < DEFAULT_REFLECTION_CANDIDATE_BUDGET);

    const quiet = replay.sessions.find((session) => session.id === 'quiet-laughter');
    assert.ok(quiet);
    assert.deepEqual(extractReflectionDeltas({ catId: quiet.catId, entries: quiet.entries }), []);
  });

  test('does not turn an explicit rejection or unresolved choice into a positive decision or desire', () => {
    const outputs = extractReflectionDeltas({
      catId: 'codex-sol',
      entries: [
        {
          role: 'user',
          content: '我不同意这个方案。我还没决定是否采用它。我不想要每日摘要。',
          sourceRef: {
            threadId: 'thread-negation',
            sessionId: 'session-negation',
            eventNo: 7,
          },
        },
      ],
    });

    assert.deepEqual(
      outputs.map((output) => output.kind),
      ['correction', 'open_loop'],
    );
    assert.equal(
      outputs.some((output) => output.kind === 'decision'),
      false,
    );
    assert.equal(
      outputs.some((output) => output.kind === 'desire_cue'),
      false,
    );
  });
});
