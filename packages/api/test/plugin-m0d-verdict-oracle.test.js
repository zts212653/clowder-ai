import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateDeclaredVerdict } from './plugin-m0d-verdict-oracle.js';

const behaviorExecution = {
  plane: 'plugin-to-host-wire',
  method: 'messaging.send',
  verdictOracle: { kind: 'behavior-expectation' },
};
const admissionExecution = {
  plane: 'wire-admission',
  method: 'messaging.send',
  verdictOracle: { kind: 'json-rpc-error', code: -32602, sideEffects: 'behavior-expectation' },
};

test('behavior oracle delegates to the signed behavior report', () => {
  assert.deepEqual(evaluateDeclaredVerdict(behaviorExecution, { passed: true, failures: [] }, {}), {
    verdict: 'pass',
    sideEffectsPassed: true,
  });
  assert.deepEqual(
    evaluateDeclaredVerdict(behaviorExecution, { passed: false, failures: ['messages: expected unchanged'] }, {}),
    { verdict: 'canonical-mismatch', sideEffectsPassed: false },
  );
});

test('admission oracle requires the exact outer JSON-RPC code, not a domain-code lookalike', () => {
  assert.deepEqual(
    evaluateDeclaredVerdict(
      admissionExecution,
      { passed: false, failures: ['errorCode: expected PERMISSION, received undefined'] },
      { status: 'error', error: { code: -32602 } },
    ),
    { verdict: 'pass', sideEffectsPassed: true },
  );
  assert.deepEqual(
    evaluateDeclaredVerdict(
      admissionExecution,
      { passed: true, failures: [] },
      { status: 'error', error: { code: -32010, data: { code: 'PERMISSION' } } },
    ),
    { verdict: 'admission-safety-failure', sideEffectsPassed: true },
  );
});

test('admission oracle rejects status or side-effect drift even when the JSON-RPC code matches', () => {
  assert.deepEqual(
    evaluateDeclaredVerdict(
      admissionExecution,
      { passed: false, failures: ['status: expected error, received success'] },
      { status: 'success', result: {} },
    ),
    { verdict: 'admission-safety-failure', sideEffectsPassed: true },
  );
  assert.deepEqual(
    evaluateDeclaredVerdict(
      admissionExecution,
      { passed: false, failures: ['messages: expected unchanged'] },
      { status: 'error', error: { code: -32602 } },
    ),
    { verdict: 'admission-safety-failure', sideEffectsPassed: false },
  );
});

test('an unknown verdict oracle fails closed', () => {
  assert.throws(
    () =>
      evaluateDeclaredVerdict(
        { plane: 'host-control', verdictOracle: { kind: 'future-oracle' } },
        { passed: true, failures: [] },
        {},
      ),
    /unsupported verdict oracle/,
  );
});
