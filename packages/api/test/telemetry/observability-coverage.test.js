/**
 * F153: Observability coverage tests — liveness probe wiring,
 * abort-path pane registry behavior, and signal consistency.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Liveness probe registration tests ---

test('F153: liveness probe register/unregister lifecycle', async (t) => {
  const { registerLivenessProbe, unregisterLivenessProbe, livenessStateToNumber } = await import(
    '../../dist/infrastructure/telemetry/instruments.js'
  );

  await t.test('livenessStateToNumber maps correctly', () => {
    assert.equal(livenessStateToNumber('dead'), 0);
    assert.equal(livenessStateToNumber('idle-silent'), 1);
    assert.equal(livenessStateToNumber('busy-silent'), 2);
    assert.equal(livenessStateToNumber('active'), 3);
  });

  await t.test('register and unregister do not throw', () => {
    const testId = `test-inv-${Date.now()}`;
    assert.doesNotThrow(() => registerLivenessProbe(testId, 'opus', () => 'active'));
    assert.doesNotThrow(() => unregisterLivenessProbe(testId));
  });

  await t.test('unregister unknown id is a no-op', () => {
    assert.doesNotThrow(() => unregisterLivenessProbe('nonexistent-id'));
  });
});

test('F153: cli-spawn wires liveness probes', () => {
  const source = readFileSync(resolve(__dirname, '../../src/utils/cli-spawn.ts'), 'utf8');

  // Must import both register and unregister
  assert.ok(source.includes('registerLivenessProbe'), 'cli-spawn must import registerLivenessProbe');
  assert.ok(source.includes('unregisterLivenessProbe'), 'cli-spawn must import unregisterLivenessProbe');

  // registerLivenessProbe must be called with invocationId
  assert.ok(
    source.includes('registerLivenessProbe(options.invocationId'),
    'cli-spawn must call registerLivenessProbe with invocationId',
  );

  // unregisterLivenessProbe must be called in cleanup
  assert.ok(
    source.includes('unregisterLivenessProbe(options.invocationId)'),
    'cli-spawn must call unregisterLivenessProbe in cleanup',
  );
});

// --- AgentPaneRegistry unit tests ---

test('F153: AgentPaneRegistry marks aborted invocations as crashed', async (t) => {
  const { AgentPaneRegistry } = await import('../../dist/domains/terminal/agent-pane-registry.js');

  const registry = new AgentPaneRegistry();
  const invId = 'inv-abort-test';

  registry.register(invId, 'wt-1', 'pane-1', 'user-1');

  await t.test('newly registered pane is running', () => {
    const pane = registry.getByInvocation(invId);
    assert.ok(pane);
    assert.equal(pane.status, 'running');
  });

  await t.test('markCrashed sets status to crashed', () => {
    registry.markCrashed(invId, null);
    const pane = registry.getByInvocation(invId);
    assert.ok(pane);
    assert.equal(pane.status, 'crashed');
    assert.ok(pane.finishedAt, 'finishedAt should be set');
  });

  await t.test('markDone sets status to done', () => {
    const invId2 = 'inv-done-test';
    registry.register(invId2, 'wt-1', 'pane-2', 'user-1');
    registry.markDone(invId2, 0);
    const pane = registry.getByInvocation(invId2);
    assert.ok(pane);
    assert.equal(pane.status, 'done');
    assert.equal(pane.exitCode, 0);
  });
});

// --- Source-level signal consistency verification ---

test('F153: abort path marks pane as crashed (not done)', () => {
  const source = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );

  // The pane registry block must check wasAbortedWithoutError
  // to ensure abort path doesn't fall through to markDone
  assert.ok(
    source.includes('hadError || wasAbortedWithoutError'),
    'Pane registry condition must include wasAbortedWithoutError to prevent abort→done inconsistency',
  );
});

test('F153: all three observation systems align on abort', () => {
  const source = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );

  // Audit log: must emit CAT_ERROR for abort
  assert.ok(
    source.includes('generator_returned_without_completion'),
    'Audit must log generator_returned_without_completion for abort path',
  );

  // OTel: must set span ERROR for abort
  assert.ok(source.includes("'invocation_aborted'"), 'OTel must emit invocation_aborted log for abort path');

  // Pane: abort must not silently markDone (checked by previous test)
});
