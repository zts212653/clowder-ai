import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateCapabilityWakeupSelector } from '../../dist/infrastructure/harness-eval/capability-wakeup/capability-wakeup-trial-provider.js';

/**
 * F192 Phase H 收尾 — contract alignment unit test for CapabilityWakeupSourceSelector.
 * Validates window selector + future trial-ids selector + reject malformed shapes.
 * 砚砚 R0: trial-ids selector defined but no durable store yet → not wired into handler.
 */
describe('CapabilityWakeupSourceSelector validation', () => {
  describe('window selector (砚砚 R0 — only honest cat-facing source ref today)', () => {
    it('accepts valid window selector', () => {
      const result = validateCapabilityWakeupSelector({
        kind: 'capability-wakeup-trial-window',
        capability: 'workspace-navigator',
        windowStartMs: 1_700_000_000_000,
        windowEndMs: 1_700_086_400_000,
      });
      assert.equal(result, null);
    });

    it('accepts window selector with optional sessionIds + ruleIds narrowing', () => {
      const result = validateCapabilityWakeupSelector({
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 1_700_000_000_000,
        windowEndMs: 1_700_086_400_000,
        sessionIds: ['s1', 's2'],
        ruleIds: ['rule-1'],
      });
      assert.equal(result, null);
    });

    it('rejects empty capability', () => {
      const result = validateCapabilityWakeupSelector({
        kind: 'capability-wakeup-trial-window',
        capability: '',
        windowStartMs: 1,
        windowEndMs: 2,
      });
      assert.match(result, /capability must be non-empty/);
    });

    it('rejects newline in capability (markdown bullet injection guard)', () => {
      const result = validateCapabilityWakeupSelector({
        kind: 'capability-wakeup-trial-window',
        capability: 'workspace-navigator\n- pwned',
        windowStartMs: 1,
        windowEndMs: 2,
      });
      assert.match(result, /capability must not contain newlines/);
    });

    it('rejects non-finite windowStartMs / windowEndMs', () => {
      for (const bad of [Infinity, NaN, -Infinity, 'not-a-number']) {
        const result = validateCapabilityWakeupSelector({
          kind: 'capability-wakeup-trial-window',
          capability: 'workspace-navigator',
          windowStartMs: bad,
          windowEndMs: 100,
        });
        assert.match(result, /windowStartMs/);
      }
    });

    it('rejects windowEndMs <= windowStartMs', () => {
      for (const [start, end] of [
        [100, 100],
        [100, 50],
      ]) {
        const result = validateCapabilityWakeupSelector({
          kind: 'capability-wakeup-trial-window',
          capability: 'workspace-navigator',
          windowStartMs: start,
          windowEndMs: end,
        });
        assert.match(result, /windowEndMs must be > windowStartMs/);
      }
    });

    it('rejects non-array sessionIds / ruleIds', () => {
      const result = validateCapabilityWakeupSelector({
        kind: 'capability-wakeup-trial-window',
        capability: 'workspace-navigator',
        windowStartMs: 1,
        windowEndMs: 2,
        sessionIds: 'not-an-array',
      });
      assert.match(result, /sessionIds must be array/);
    });

    // 砚砚 R1 P2: validate element shape, not just array container.
    // Future provider must not see [42] / ['ok', ''] / [null] as validated input.
    it('rejects non-string / empty-string entries in sessionIds / ruleIds', () => {
      for (const field of ['sessionIds', 'ruleIds']) {
        for (const bad of [[42], [null], ['ok', ''], [{ id: 'x' }], [undefined]]) {
          const result = validateCapabilityWakeupSelector({
            kind: 'capability-wakeup-trial-window',
            capability: 'workspace-navigator',
            windowStartMs: 1,
            windowEndMs: 2,
            [field]: bad,
          });
          assert.match(
            result,
            new RegExp(`${field} entries must be non-empty strings`),
            `${field}=${JSON.stringify(bad)} should reject`,
          );
        }
      }
    });
  });

  describe('trial-ids selector (future, no durable store yet)', () => {
    it('accepts valid trial-ids selector', () => {
      const result = validateCapabilityWakeupSelector({
        kind: 'capability-wakeup-trial-ids',
        trialIds: ['t1', 't2'],
      });
      assert.equal(result, null);
    });

    it('rejects empty trialIds array', () => {
      const result = validateCapabilityWakeupSelector({
        kind: 'capability-wakeup-trial-ids',
        trialIds: [],
      });
      assert.match(result, /trialIds must be non-empty array/);
    });

    it('rejects non-string trialIds entries', () => {
      const result = validateCapabilityWakeupSelector({
        kind: 'capability-wakeup-trial-ids',
        trialIds: ['ok', 42, ''],
      });
      assert.match(result, /trialIds entries must be non-empty strings/);
    });
  });

  describe('shape guards', () => {
    it('rejects null / non-object', () => {
      for (const bad of [null, undefined, 'string', 42, true]) {
        const result = validateCapabilityWakeupSelector(bad);
        assert.match(result, /selector must be an object/);
      }
    });

    it('rejects unknown selector kind', () => {
      const result = validateCapabilityWakeupSelector({ kind: 'mystery-kind', data: 'foo' });
      assert.match(result, /unknown selector kind/);
    });
  });
});
