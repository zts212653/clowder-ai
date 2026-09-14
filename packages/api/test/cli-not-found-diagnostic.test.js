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
import { CLIENT_DESCRIPTORS, installHintForCommand } from '@cat-cafe/shared';

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

test('advertises the path escape hatch only for the command the pin can answer for', () => {
  // `CAT_<CLIENT>_PATH` pins the client's canonical command (utils/cli-resolve.ts
  // `pinnedPathFor`), so a fixed "set CAT_<CLIENT>_PATH" sentence sent alias failures
  // (gemini under GEMINI_ADAPTER=gemini-cli, kimi-cli) to a variable that cannot fix them:
  // the availability probe turns green because its override branch only reads the env var,
  // while the launch path keeps resolving the alias through PATH and keeps failing.
  const withPin = CLIENT_DESCRIPTORS.filter((descriptor) => descriptor.pathEnvVar);
  assert.ok(withPin.length > 0, 'expected at least one client with a path escape hatch');
  for (const descriptor of withPin) {
    const canonicalHint = buildCliNotFoundDiagnostic(descriptor.defaultCli.command, 'linux').publicHint;
    assert.ok(
      canonicalHint.includes(descriptor.pathEnvVar),
      `${descriptor.pathEnvVar} must be offered for its canonical command ${descriptor.defaultCli.command}`,
    );
    for (const alias of descriptor.commands.filter((command) => command !== descriptor.defaultCli.command)) {
      const aliasHint = buildCliNotFoundDiagnostic(alias, 'linux').publicHint;
      assert.equal(
        aliasHint.includes(descriptor.pathEnvVar),
        false,
        `${descriptor.pathEnvVar} must not be offered for alias ${alias} — the pin cannot fix it`,
      );
      // Suppressing the useless hint must not leave the alias without advice that works: it still
      // has to carry its own install command (every alias, not just the one we happened to sample).
      const install = installHintForCommand(alias, 'linux');
      assert.ok(install, `${alias} should resolve an install hint`);
      assert.ok(aliasHint.includes(install), `${alias} must still be told how to install itself`);
    }
  }
  // No env var exists for a command outside the descriptor registry, so none may be invented.
  const unknown = buildCliNotFoundDiagnostic('some-future-cli', 'linux');
  assert.equal(/CAT_/.test(unknown.publicHint), false);
  assert.match(unknown.publicHint, /PATH/);
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
