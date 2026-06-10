import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CapabilityWakeupTrialProviderImpl } from '../../dist/infrastructure/harness-eval/capability-wakeup/capability-wakeup-trial-provider-impl.js';

/**
 * F192 Phase H 收尾 PR-2 R9 P1 (cloud): split from
 * capability-wakeup-trial-provider-impl.test.js to keep both files under
 * AGENTS.md 350-line hard limit. Constructor fail-closed tests are self-contained
 * (no mocks needed beyond per-test minimal port stubs).
 *
 * 砚砚 R1 Q5: missing port → throw, NEVER silent-empty (would manufacture
 * fake misses that look like real signal).
 */
describe('CapabilityWakeupTrialProviderImpl constructor fail-closed (砚砚 R1 Q5)', () => {
  it('throws when sessionStore missing', () => {
    assert.throws(
      () =>
        new CapabilityWakeupTrialProviderImpl({
          transcriptReader: {},
          toolEventLog: {},
          skillLoadEventLog: {},
        }),
      /missing required port.*sessionStore/i,
    );
  });

  it('throws when transcriptReader missing', () => {
    assert.throws(
      () =>
        new CapabilityWakeupTrialProviderImpl({
          sessionStore: {},
          toolEventLog: {},
          skillLoadEventLog: {},
        }),
      /missing required port.*transcriptReader/i,
    );
  });

  it('throws when toolEventLog missing', () => {
    assert.throws(
      () =>
        new CapabilityWakeupTrialProviderImpl({
          sessionStore: {},
          transcriptReader: {},
          skillLoadEventLog: {},
        }),
      /missing required port.*toolEventLog/i,
    );
  });

  it('throws when skillLoadEventLog missing', () => {
    assert.throws(
      () =>
        new CapabilityWakeupTrialProviderImpl({
          sessionStore: {},
          transcriptReader: {},
          toolEventLog: {},
        }),
      /missing required port.*skillLoadEventLog/i,
    );
  });
});
