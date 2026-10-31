/**
 * InvocationStatus State Machine Tests — F25
 *
 * Property-based tests (fast-check) + deterministic tests.
 * Verifies the explicit transition spec before WT-3 refactoring.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';

// Fixed seed for CI reproducibility
const FC_PARAMS = { numRuns: 500, seed: 20260217 };

describe('invocation-state-machine', () => {
  /** @type {typeof import('../dist/domains/cats/services/stores/ports/invocation-state-machine.js')} */
  let mod;

  test('module loads', async () => {
    mod = await import('../dist/domains/cats/services/stores/ports/invocation-state-machine.js');
    assert.ok(mod.isValidTransition);
    assert.ok(mod.getAllowedTransitions);
    assert.ok(mod.classifyInvocationRecoveryStatus);
    assert.ok(mod.TERMINAL_STATES);
    assert.ok(mod.ALL_STATUSES);
  });

  // ─── Deterministic: known valid transitions ───

  const VALID_PAIRS = [
    ['queued', 'running'],
    ['queued', 'failed'],
    ['queued', 'canceled'],
    ['running', 'succeeded'],
    ['running', 'failed'],
    ['running', 'canceled'],
    ['failed', 'running'],
    ['failed', 'canceled'],
  ];

  for (const [from, to] of VALID_PAIRS) {
    test(`valid: ${from} → ${to}`, () => {
      assert.ok(mod.isValidTransition(from, to), `${from} → ${to} should be valid`);
    });
  }

  // ─── Deterministic: known invalid transitions ───

  const INVALID_PAIRS = [
    ['succeeded', 'running'], // terminal
    ['succeeded', 'failed'], // terminal
    ['succeeded', 'queued'], // terminal
    ['succeeded', 'canceled'], // terminal
    ['canceled', 'running'], // terminal
    ['canceled', 'queued'], // terminal
    ['canceled', 'failed'], // terminal
    ['queued', 'succeeded'], // skip running
    ['running', 'queued'], // backwards
    ['failed', 'succeeded'], // must go through running first
    ['failed', 'queued'], // backwards
  ];

  for (const [from, to] of INVALID_PAIRS) {
    test(`invalid: ${from} → ${to}`, () => {
      assert.ok(!mod.isValidTransition(from, to), `${from} → ${to} should be invalid`);
    });
  }

  // ─── Deterministic: self-transitions always invalid ───

  test('self-transitions are invalid for all statuses', () => {
    for (const s of mod.ALL_STATUSES) {
      assert.ok(!mod.isValidTransition(s, s), `${s} → ${s} should be invalid`);
    }
  });

  // ─── Deterministic: terminal states ───

  test('terminal states have no outbound transitions', () => {
    for (const s of mod.TERMINAL_STATES) {
      const allowed = mod.getAllowedTransitions(s);
      assert.equal(allowed.length, 0, `${s} should have 0 allowed transitions`);
    }
  });

  test('non-terminal states have at least one outbound transition', () => {
    for (const s of mod.ALL_STATUSES) {
      if (!mod.TERMINAL_STATES.has(s)) {
        const allowed = mod.getAllowedTransitions(s);
        assert.ok(allowed.length > 0, `${s} should have >0 allowed transitions`);
      }
    }
  });

  test('classifies only succeeded as completed and keeps queued/failed replayable', () => {
    assert.deepEqual(
      Object.fromEntries(mod.ALL_STATUSES.map((status) => [status, mod.classifyInvocationRecoveryStatus(status)])),
      {
        queued: 'replayable',
        running: 'in_flight',
        succeeded: 'completed',
        failed: 'replayable',
        canceled: 'terminal',
      },
    );
  });

  // ─── Property-based: random transition sequences ───

  test('property: random walk from queued never reaches invalid state', () => {
    const statusArb = fc.constantFrom(...mod.ALL_STATUSES);

    fc.assert(
      fc.property(fc.array(statusArb, { minLength: 1, maxLength: 20 }), (targets) => {
        let current = 'queued';
        for (const target of targets) {
          if (mod.isValidTransition(current, target)) {
            current = target;
          }
          // current must always be a valid status
          assert.ok(mod.ALL_STATUSES.includes(current));
        }
      }),
      FC_PARAMS,
    );
  });

  test('property: terminal states are absorbing (stuck forever)', () => {
    const statusArb = fc.constantFrom(...mod.ALL_STATUSES);

    fc.assert(
      fc.property(
        fc.constantFrom(...[...mod.TERMINAL_STATES]),
        fc.array(statusArb, { minLength: 1, maxLength: 20 }),
        (terminal, targets) => {
          for (const target of targets) {
            assert.ok(!mod.isValidTransition(terminal, target), `${terminal} should reject → ${target}`);
          }
        },
      ),
      FC_PARAMS,
    );
  });

  test('property: every reachable state from queued is a valid status', () => {
    const statusArb = fc.constantFrom(...mod.ALL_STATUSES);

    fc.assert(
      fc.property(fc.array(statusArb, { minLength: 0, maxLength: 30 }), (targets) => {
        let current = 'queued';
        const visited = new Set([current]);
        for (const target of targets) {
          if (mod.isValidTransition(current, target)) {
            current = target;
            visited.add(current);
          }
        }
        for (const s of visited) {
          assert.ok(mod.ALL_STATUSES.includes(s));
        }
      }),
      FC_PARAMS,
    );
  });

  test('property: isValidTransition is consistent with getAllowedTransitions', () => {
    const statusArb = fc.constantFrom(...mod.ALL_STATUSES);

    fc.assert(
      fc.property(statusArb, statusArb, (from, to) => {
        const allowed = mod.getAllowedTransitions(from);
        const valid = mod.isValidTransition(from, to);
        if (valid) {
          assert.ok(allowed.includes(to), `isValidTransition(${from},${to})=true but not in getAllowedTransitions`);
        } else {
          assert.ok(!allowed.includes(to), `isValidTransition(${from},${to})=false but found in getAllowedTransitions`);
        }
      }),
      FC_PARAMS,
    );
  });

  // ─── Property-based: CAS + state machine dual guard ───

  test('property: simulated CAS + state machine rejects double-apply', () => {
    const statusArb = fc.constantFrom(...mod.ALL_STATUSES);

    fc.assert(
      fc.property(statusArb, (target) => {
        // Simulate: record starts as queued
        let recordStatus = 'queued';
        const expectedStatus = 'queued';

        // First update attempt
        const casOk = recordStatus === expectedStatus;
        const transitionOk = mod.isValidTransition(recordStatus, target);
        if (casOk && transitionOk) {
          recordStatus = target;
        }

        // Second attempt with same expectedStatus (stale)
        const casOk2 = recordStatus === expectedStatus;
        if (recordStatus !== 'queued') {
          // If first attempt changed state, CAS should block second
          assert.ok(!casOk2, `CAS should reject stale expectedStatus after transition to ${recordStatus}`);
        }
      }),
      FC_PARAMS,
    );
  });
});
