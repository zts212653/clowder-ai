/**
 * buildCliNotFoundDiagnostic tests.
 *
 * Two things are being defended here:
 *   1. a missing CLI now reaches the folded diagnostics panel at all (it used to be a bare red
 *      bubble, because the not-found path emitted no cliDiagnostics);
 *   2. it must stay OUT of the auto-issue allowlist. `spawn_failed` is a triggering code, so
 *      routing "user has not installed Claude Code" through it would file an issue against the
 *      project on every fresh install.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { buildCliNotFoundDiagnostic } = await import('../dist/utils/cli-diagnostics.js');
const { TRIGGERING_REASON_CODES } = await import('../dist/domains/cats/services/frustration/FrustrationDetector.js');

test('emits a structured diagnostic a folded panel can render', () => {
  const diagnostic = buildCliNotFoundDiagnostic('claude', 'linux');

  assert.equal(diagnostic.reasonCode, 'cli_not_found');
  assert.match(diagnostic.publicSummary, /claude/);
  assert.equal(diagnostic.debugRef.command, 'claude');
  assert.equal(diagnostic.debugRef.signal, null);
  // There is no exit code and no stderr for this failure, so neither may be invented.
  assert.equal(diagnostic.debugRef.exitCode, undefined);
  assert.equal(diagnostic.safeExcerpt, undefined);
});

test('carries the platform-appropriate install command', () => {
  assert.match(buildCliNotFoundDiagnostic('claude', 'linux').publicHint, /@anthropic-ai\/claude-code/);
  assert.match(buildCliNotFoundDiagnostic('agy', 'win32').publicHint, /install\.cmd/);
  assert.match(buildCliNotFoundDiagnostic('agy', 'darwin').publicHint, /install\.sh/);
});

test('names the path escape hatch without inventing one for unknown commands', () => {
  assert.match(buildCliNotFoundDiagnostic('kimi', 'linux').publicHint, /CAT_<CLIENT>_PATH/);
  const unknown = buildCliNotFoundDiagnostic('some-future-cli', 'linux');
  assert.match(unknown.publicHint, /CAT_<CLIENT>_PATH/);
  assert.equal(/undefined|\[object/.test(unknown.publicHint), false, 'no templating leftovers');
});

test('keeps publicHint plain text — the panel renders it verbatim', () => {
  const hint = buildCliNotFoundDiagnostic('claude', 'linux').publicHint;
  assert.equal(hint.includes('`'), false, 'no markdown backticks');
  assert.equal(hint.includes('*'), false, 'no markdown emphasis');
});

test('cli_not_found must never auto-file an issue', () => {
  assert.equal(
    TRIGGERING_REASON_CODES.has('cli_not_found'),
    false,
    'a missing CLI is user-environment state, not a defect in our spawn path',
  );
  // The neighbouring code keeps triggering: this change must not have widened the net by
  // accidentally reusing it.
  assert.equal(TRIGGERING_REASON_CODES.has('spawn_failed'), true);
});
