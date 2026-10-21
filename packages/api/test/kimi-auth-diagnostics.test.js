import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTransientCliExitCode1 } from '../dist/domains/cats/services/agents/invocation/invoke-helpers.js';
import { nativeRuntimeReadiness } from '../dist/routes/native-runtime-readiness.js';
import { buildCliDiagnostics, classifyCliError } from '../dist/utils/cli-diagnostics.js';
import { formatCliExitError } from '../dist/utils/cli-format.js';
import { spawnCli } from '../dist/utils/cli-spawn.js';

for (const witness of [
  'error: failed to run prompt: The provided authorization grant is invalid',
  'error: failed to run prompt: provider managed:kimi-code has no credential configured',
]) {
  test(`Kimi witnessed authentication failure is actionable and not transient: ${witness}`, () => {
    assert.equal(classifyCliError(witness), 'auth_failed');
    const diagnostics = buildCliDiagnostics({
      rawText: witness,
      debugRef: { command: 'kimi', exitCode: 1, signal: null },
    });
    assert.match(diagnostics.publicSummary, /认证失败/);
    assert.match(diagnostics.publicHint, /实际使用.*HOME\/profile/);
    const message = formatCliExitError('Kimi CLI', {
      exitCode: 1,
      signal: null,
      message: 'CLI 异常退出 (code: 1, signal: none)',
      reasonCode: diagnostics.reasonCode,
    });
    assert.equal(isTransientCliExitCode1(message), false);
  });
}

test('only classified authentication failures avoid code-one retry', () => {
  const message = 'Kimi CLI: CLI 异常退出 (code: 1, signal: none)';
  assert.equal(isTransientCliExitCode1(`${message} [auth_failed]`), false);
  assert.equal(isTransientCliExitCode1(message), true);
  assert.equal(classifyCliError('provider sample has no models configured'), undefined);
});

test('installed Kimi remains unverified but supplies login guidance before a turn', async () => {
  const result = await nativeRuntimeReadiness({ id: 'kimi', installed: true, command: 'fixture-kimi' }, 'fixture');
  assert.equal(result.status, 'unknown');
  assert.match(result.loginCommand ?? '', /fixture-kimi/);
  assert.match(result.loginCommand ?? '', /login/);
  assert.match(result.loginCommand ?? '', /HOME/);
  assert.doesNotMatch(JSON.stringify(result), /access_token|refresh_token/);
});

test('actual child stderr produces the classified public diagnostics used by Kimi', async () => {
  const events = [];
  for await (const event of spawnCli({
    command: process.execPath,
    args: [
      '-e',
      "console.error('error: failed to run prompt: provider managed:kimi-code has no credential configured');process.exitCode=1;",
    ],
  }))
    events.push(event);
  const error = events.find((event) => '__cliError' in event);
  assert.ok(error && '__cliError' in error);
  assert.equal(error.reasonCode, 'auth_failed');
  assert.match(error.cliDiagnostics?.publicSummary ?? '', /认证失败/);
  assert.equal(isTransientCliExitCode1(formatCliExitError('Kimi CLI', error)), false);
});
