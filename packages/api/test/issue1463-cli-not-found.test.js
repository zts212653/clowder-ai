/**
 * #1463 S3: a missing provider CLI must surface through the existing F212
 * `metadata.cliDiagnostics` channel instead of a bare text bubble.
 *
 * The shortcut happens before spawn, so these tests also pin that no process evidence
 * (exit code, stderr/safeExcerpt) is invented and that `cli_not_found` never auto-files
 * an issue.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { buildCliNotFoundDiagnostic } = await import('../dist/utils/cli-diagnostics.js');
const { shouldTrigger, TRIGGERING_REASON_CODES } = await import(
  '../dist/domains/cats/services/frustration/FrustrationDetector.js'
);
const { AgyNativeStartupError } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-errors.js'
);
const { missingAgyNativeCliError } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-launch.js'
);
const { KimiAgentService } = await import('../dist/domains/cats/services/agents/providers/KimiAgentService.js');
const { catRegistry } = await import('@cat-cafe/shared');
const { invalidateCliCommand, resolveCliCommand } = await import('../dist/utils/cli-resolve.js');

function assertNoProcessEvidence(diagnostic) {
  assert.equal(diagnostic.safeExcerpt, undefined, 'no stderr exists before spawn');
  assert.equal(diagnostic.debugRef.exitCode, undefined, 'no exit code exists before spawn');
  assert.equal(diagnostic.debugRef.signal, null, 'no signal exists before spawn');
}

test('buildCliNotFoundDiagnostic emits a structured cli_not_found payload', () => {
  assert.equal(typeof buildCliNotFoundDiagnostic, 'function', 'S3 builder is missing');
  const diagnostic = buildCliNotFoundDiagnostic('kimi', 'linux');

  assert.equal(diagnostic.reasonCode, 'cli_not_found');
  assert.match(diagnostic.publicSummary, /kimi CLI 未找到/);
  assert.match(diagnostic.publicHint, /kimi-code\/install\.sh/);
  assert.equal(diagnostic.debugRef.command, 'kimi');
  assertNoProcessEvidence(diagnostic);
  // The folded panel renders publicHint verbatim, not as Markdown.
  assert.equal(diagnostic.publicHint.includes('`'), false);
});

test('Windows install hint stays platform-specific', () => {
  assert.equal(typeof buildCliNotFoundDiagnostic, 'function', 'S3 builder is missing');
  const diagnostic = buildCliNotFoundDiagnostic('agy', 'win32');
  assert.match(diagnostic.publicHint, /install\.cmd/);
  assert.equal(diagnostic.publicHint.includes('install.sh'), false);
});

test('cli_not_found never auto-files an issue, while spawn_failed still does', () => {
  assert.equal(TRIGGERING_REASON_CODES.has('cli_not_found'), false);
  assert.equal(TRIGGERING_REASON_CODES.has('spawn_failed'), true);

  const missing = { type: 'cli_error', diagnostics: { reasonCode: 'cli_not_found' } };
  const spawned = { type: 'cli_error', diagnostics: { reasonCode: 'spawn_failed' } };
  assert.equal(shouldTrigger(missing), false);
  assert.equal(shouldTrigger(spawned), true);
});

test('AGY missing binary uses AgyNativeStartupError with the same diagnostic', () => {
  assert.equal(typeof missingAgyNativeCliError, 'function', 'AGY missing-CLI factory is missing');
  const error = missingAgyNativeCliError();

  assert.ok(error instanceof AgyNativeStartupError);
  assert.match(error.message, /agy CLI 未找到/);
  assert.equal(error.cliDiagnostics?.reasonCode, 'cli_not_found');
  assert.match(error.cliDiagnostics?.publicHint ?? '', /antigravity\.google\/cli\/install/);
  assertNoProcessEvidence(error.cliDiagnostics);
});

test('Kimi missing CLI yields cliDiagnostics without spawning', async () => {
  const home = mkdtempSync(join(tmpdir(), 'issue1463-kimi-'));
  const originalPath = process.env.PATH;
  const originalWinPath = process.env.Path;
  const originalAppData = process.env.APPDATA;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalKimiHome = process.env.KIMI_CODE_HOME;

  try {
    process.env.APPDATA = join(home, 'AppData', 'Roaming');
    process.env.LOCALAPPDATA = join(home, 'AppData', 'Local');
    process.env.KIMI_CODE_HOME = join(home, '.kimi-code');
    process.env.PATH = '';
    process.env.Path = '';
    invalidateCliCommand('kimi');
    invalidateCliCommand('kimi-cli');
    assert.equal(resolveCliCommand('kimi'), null, 'fixture must have no Kimi CLI');
    assert.equal(resolveCliCommand('kimi-cli'), null, 'fixture must have no legacy Kimi CLI');

    catRegistry.register('issue1463-kimi', {
      id: 'issue1463-kimi',
      name: 'issue1463-kimi',
      displayName: 'Issue 1463 fixture',
      clientId: 'kimi',
      carrier: 'cli',
      configurationSource: 'native_tool',
      defaultModel: '',
      cli: { command: 'kimi', outputFormat: 'stream-json' },
    });

    let spawned = false;
    const service = new KimiAgentService({
      catId: 'issue1463-kimi',
      model: '',
      spawnFn: () => {
        spawned = true;
        throw new Error('missing-CLI path must not spawn');
      },
    });
    const events = await Array.fromAsync(service.invoke('fixture prompt', { workingDirectory: home }));
    const error = events.find((event) => event.type === 'error');

    assert.equal(spawned, false, 'missing-CLI preflight must short-circuit before spawn');
    assert.ok(error, 'expected an error event');
    assert.match(error.error, /kimi CLI 未找到/);
    assert.equal(error.metadata?.cliDiagnostics?.reasonCode, 'cli_not_found');
    assert.equal(error.metadata?.cliDiagnostics?.debugRef?.command, 'kimi');
    assertNoProcessEvidence(error.metadata.cliDiagnostics);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalWinPath === undefined) delete process.env.Path;
    else process.env.Path = originalWinPath;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    if (originalKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = originalKimiHome;
  }
});
