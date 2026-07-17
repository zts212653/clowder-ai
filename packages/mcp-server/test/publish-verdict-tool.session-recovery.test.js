import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { publishVerdictInputSchema } from '../dist/tools/publish-verdict-tool.js';

const schema = z.object(publishVerdictInputSchema);
const packet = {
  id: 'session-recovery-mcp-schema',
  domainId: 'eval:session-recovery',
  createdAt: '2026-07-16T10:00:00.000Z',
  phenomenon: 'schema test',
  verdict: 'keep_observe',
};

function assessment(overrides = {}) {
  return {
    trialId: 'session-recovery:source-1',
    stateReconstruction: 'recovered',
    firstMeaningfulAction: 'aligned',
    firstMeaningfulEventRef: 'transcript:target-1:event:2',
    outcome: 'continued',
    evidenceRefs: ['session:source-1', 'transcript:target-1:event:2'],
    rationale: 'Anchor-only semantic assessment.',
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    domainId: 'eval:session-recovery',
    packet,
    sourceRefs: {
      kind: 'session-recovery-window',
      windowStartMs: 1_000,
      windowEndMs: 2_000,
      catId: 'cat-vjdun65e',
      threadId: 'thread-1',
      limit: 50,
      assessments: [assessment()],
      ...overrides,
    },
  };
}

describe('cat_cafe_publish_verdict session-recovery sourceRefs schema', () => {
  it('accepts a bounded selector with explicit semantic assessments', () => {
    const result = schema.safeParse(input());
    assert.equal(result.success, true, JSON.stringify(result));
  });

  it('requires assessments and bounds assessment/evidence cardinality', () => {
    assert.equal(schema.safeParse(input({ assessments: undefined })).success, false);
    assert.equal(schema.safeParse(input({ assessments: [] })).success, false);
    assert.equal(schema.safeParse(input({ assessments: [assessment({ evidenceRefs: [] })] })).success, false);
    assert.equal(schema.safeParse(input({ limit: 201 })).success, false);
    assert.equal(schema.safeParse(input({ assessments: [assessment(), assessment()] })).success, false);
    assert.equal(schema.safeParse(input({ windowEndMs: 1_000 })).success, false);
    assert.equal(schema.safeParse(input({ windowEndMs: 1_000 + 32 * 86_400_000 })).success, false);
  });

  it('rejects invalid semantic labels and newline-injected anchors', () => {
    assert.equal(
      schema.safeParse(input({ assessments: [assessment({ stateReconstruction: 'invented' })] })).success,
      false,
    );
    assert.equal(
      schema.safeParse(input({ assessments: [assessment({ trialId: 'session-recovery:source-1\nforged' })] })).success,
      false,
    );
    assert.equal(
      schema.safeParse(input({ assessments: [assessment({ evidenceRefs: ['session:source-1\nforged'] })] })).success,
      false,
    );
    assert.equal(
      schema.safeParse(input({ assessments: [assessment({ firstMeaningfulEventRef: undefined })] })).success,
      false,
    );
    assert.equal(
      schema.safeParse(input({ assessments: [assessment({ evidenceRefs: ['session:source-1'] })] })).success,
      false,
    );
    assert.equal(
      schema.safeParse(
        input({
          assessments: [
            assessment({ firstMeaningfulAction: 'unknown', firstMeaningfulEventRef: 'transcript:target-1:event:2' }),
          ],
        }),
      ).success,
      false,
    );
  });
});
