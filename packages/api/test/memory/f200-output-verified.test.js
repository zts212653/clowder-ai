import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('F200 Phase D — OutputVerifiedDetector', () => {
  let OutputVerifiedDetector;

  before(async () => {
    const mod = await import(`../../dist/domains/memory/output-verified-detector.js?v=${Date.now()}`);
    OutputVerifiedDetector = mod.OutputVerifiedDetector;
  });

  function makeDetector(invocationStatus, prMerged) {
    return new OutputVerifiedDetector({
      getInvocationStatus: async (invId) => invocationStatus,
      isPrMergedForThread: async (threadId) => prMerged,
    });
  }

  it('returns verified=true when invocation succeeded AND PR merged', async () => {
    const detector = makeDetector('succeeded', true);
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, true);
    assert.ok(result.signals.includes('invocation_succeeded'));
    assert.ok(result.signals.includes('pr_merged'));
  });

  it('returns verified=true when PR merged even if invocation status unknown', async () => {
    const detector = makeDetector(null, true);
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, true);
    assert.ok(result.signals.includes('pr_merged'));
  });

  it('returns verified=false when only invocation_succeeded (no strong signal)', async () => {
    const detector = makeDetector('succeeded', false);
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, false);
    assert.ok(result.signals.includes('invocation_succeeded'));
    assert.ok(!result.signals.includes('pr_merged'));
  });

  it('returns verified=false when invocation failed', async () => {
    const detector = makeDetector('failed', false);
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, false);
    assert.equal(result.signals.length, 0);
  });

  it('returns verified=false when no signals present', async () => {
    const detector = makeDetector(null, false);
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, false);
    assert.equal(result.signals.length, 0);
  });

  it('handles errors gracefully', async () => {
    const detector = new OutputVerifiedDetector({
      getInvocationStatus: async () => {
        throw new Error('redis down');
      },
      isPrMergedForThread: async () => {
        throw new Error('redis down');
      },
    });
    const result = await detector.detect('inv-001', 'thread-001');
    assert.equal(result.verified, false);
    assert.equal(result.signals.length, 0);
  });
});
