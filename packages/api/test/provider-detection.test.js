/**
 * provider-detection unit tests.
 *
 * Guards the two decisions that make this detector safe to run inside the API process:
 *   1. detection starts NO process at all — LL-055 is upheld literally, with no opt-in escape
 *      hatch, and the guarantee is structural (there is no version-probe seam to stub);
 *   2. a broken `CAT_<CLIENT>_PATH` override is a hard error, never a silent fall-through to
 *      whatever PATH happens to resolve — an operator who pinned a binary must not be handed
 *      a different one.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLIENT_DESCRIPTORS } from '@cat-cafe/shared';

const { detectProviderAvailability } = await import(
  '../dist/domains/cats/services/agents/providers/provider-detection.js'
);

function byId(report, clientId) {
  const provider = report.providers.find((p) => p.clientId === clientId);
  assert.ok(provider, `missing provider ${clientId}`);
  return provider;
}

test('resolves a CLI on PATH and reports where it came from', async () => {
  const resolveCommand = mock.fn((command) => (command === 'claude' ? '/usr/local/bin/claude' : null));
  const report = await detectProviderAvailability({ resolveCommand, env: {} });

  const anthropic = byId(report, 'anthropic');
  assert.equal(anthropic.installed, true);
  assert.equal(anthropic.status, 'configured');
  assert.equal(anthropic.resolvedVia, 'path');
  assert.equal(anthropic.resolvedPath, '/usr/local/bin/claude');
  assert.equal(anthropic.command, 'claude');
  assert.equal(anthropic.toolId, 'claude');

  const openai = byId(report, 'openai');
  assert.equal(openai.installed, false);
  assert.equal(openai.status, 'missing');
  assert.match(openai.reason, /未在本机找到/);
});

test('a missing-CLI reason pins exactly the canonical command, for every client', async () => {
  const resolveCommand = mock.fn(() => null);
  const report = await detectProviderAvailability({ resolveCommand, env: {} });

  const withPin = CLIENT_DESCRIPTORS.filter((descriptor) => descriptor.pathEnvVar);
  assert.ok(withPin.length > 0, 'expected at least one client with a path escape hatch');
  for (const descriptor of withPin) {
    const reason = byId(report, descriptor.clientId).reason;
    assert.ok(reason, `${descriptor.clientId} must explain the miss`);
    assert.match(reason, /未在本机找到/);
    assert.ok(
      reason.includes(descriptor.commands.join(' / ')),
      `${descriptor.clientId} must list every candidate it checked`,
    );
    // The pin answers for the canonical command only (cli-resolve.ts `pinnedPathFor`). A generic
    // "point it at the binary" — or the canonical/alias pair reversed — would send a
    // `GEMINI_ADAPTER=gemini-cli` / legacy-`kimi-cli` operator to a variable that cannot fix the
    // launch (probe green, launch still fails). The phrase is asserted in full rather than by
    // substring of the command name: `kimi` is a prefix of its own alias `kimi-cli`.
    const promise = reason.slice(reason.lastIndexOf('或设置'));
    assert.ok(
      promise.includes(`${descriptor.pathEnvVar} 指向 ${descriptor.defaultCli.command} 二进制`),
      `${descriptor.pathEnvVar} must be offered for ${descriptor.defaultCli.command}, got "${promise}"`,
    );
    for (const alias of descriptor.commands.filter((command) => command !== descriptor.defaultCli.command)) {
      assert.equal(
        promise.includes(alias),
        false,
        `${descriptor.pathEnvVar} must not be offered against alias ${alias} (got "${promise}")`,
      );
    }
  }
});

test('an explicit path override wins and is reported as such', async () => {
  const resolveCommand = mock.fn(() => null);
  const report = await detectProviderAvailability({
    resolveCommand,
    isExecutableFile: (path) => path === '/opt/pinned/claude',
    env: { CAT_ANTHROPIC_PATH: '/opt/pinned/claude' },
  });

  const anthropic = byId(report, 'anthropic');
  assert.equal(anthropic.installed, true);
  assert.equal(anthropic.resolvedVia, 'env-override');
  assert.equal(anthropic.resolvedPath, '/opt/pinned/claude');
  assert.equal(
    resolveCommand.mock.calls.some((call) => call.arguments[0] === 'claude'),
    false,
    'a working override must not probe PATH for that command',
  );
});

test('a broken override is a hard error, not a silent PATH fall-through', async () => {
  const resolveCommand = mock.fn((command) => (command === 'claude' ? '/usr/local/bin/claude' : null));
  const report = await detectProviderAvailability({
    resolveCommand,
    isExecutableFile: () => false,
    env: { CAT_ANTHROPIC_PATH: '/opt/gone/claude' },
  });

  const anthropic = byId(report, 'anthropic');
  assert.equal(anthropic.installed, false);
  assert.equal(anthropic.status, 'error');
  assert.match(anthropic.reason, /CAT_ANTHROPIC_PATH/);
  assert.match(anthropic.reason, /\/opt\/gone\/claude/);
  assert.equal(
    resolveCommand.mock.calls.some((call) => call.arguments[0] === 'claude'),
    false,
    'the operator pinned a path; falling back to PATH would launch a different binary',
  );
});

test('clients with no local CLI are unsupported rather than missing', async () => {
  const report = await detectProviderAvailability({ resolveCommand: () => null, env: {} });

  for (const clientId of ['antigravity', 'a2a', 'catagent', 'acp']) {
    const provider = byId(report, clientId);
    assert.equal(provider.localCli, false);
    assert.equal(provider.status, 'unsupported');
    assert.equal(provider.installed, false);
  }
  const installedLocal = report.providers.filter((p) => p.installed && p.localCli);
  assert.equal(
    installedLocal.some((p) => !p.localCli),
    false,
    'a bridged client must never count as an installed local CLI',
  );
});

test('starts no process — no version field, no opt-in flag, no spawn seam (LL-055)', async () => {
  // LL-055 is upheld literally rather than by an opt-in: `opencode version` boots a full agent
  // process, ignores SIGTERM, and on macOS leaves a PPID=1 orphan burning CPU. The guarantee is
  // structural — the detector has no version-probe dependency to stub, so a test can prove the
  // absence rather than observe a mock that merely went uncalled.
  const module = await import('../dist/domains/cats/services/agents/providers/provider-detection.js');
  for (const name of Object.keys(module)) {
    assert.equal(
      /version|spawn|exec/i.test(name),
      false,
      `provider-detection must not export a ${name} seam (LL-055 forbids spawning for detection)`,
    );
  }

  const report = await detectProviderAvailability({
    resolveCommand: (command) => `/usr/local/bin/${command}`,
    env: {},
  });
  for (const provider of report.providers) {
    assert.equal(provider.version, undefined, `${provider.clientId} must not report a version`);
  }
  assert.equal('versionProbeEnabled' in report, false, 'the report has no version-probe state');
});

test('the detector module imports no child-process API at all', () => {
  // Belt and braces on the same guarantee: even an unused import would signal that a spawn path
  // is being reintroduced. `node:fs` (statSync) is allowed; process APIs are not.
  const source = readFileSync(
    fileURLToPath(new URL('../src/domains/cats/services/agents/providers/provider-detection.ts', import.meta.url)),
    'utf-8',
  );
  assert.equal(/from 'node:child_process'/.test(source), false, 'detection must not import node:child_process');
  assert.equal(/execFile|spawn\(|exec\(/.test(source), false, 'detection must not execute anything');
});

test('one throwing provider cannot blank the report', async () => {
  const resolveCommand = mock.fn((command) => {
    if (command === 'opencode') throw new Error('synthetic resolver failure');
    return null;
  });
  const report = await detectProviderAvailability({ resolveCommand, env: {} });

  assert.equal(report.providers.length, 9, 'every descriptor still reports');
  const opencode = byId(report, 'opencode');
  assert.equal(opencode.installed, false);
  assert.match(opencode.reason, /探测失败/);
});

test('reports exactly one record per descriptor, keyed by clientId', async () => {
  // Deliberately no convenience lookup helpers here: `installedProviders` /
  // `availabilityByClientId` had no production consumer, so they were removed rather than
  // shipped as speculative surface. Consumers index `report.providers` directly.
  const report = await detectProviderAvailability({
    resolveCommand: (command) => (command === 'codex' ? '/usr/local/bin/codex' : null),
    env: {},
  });
  const byId = new Map(report.providers.map((p) => [p.clientId, p]));
  assert.equal(byId.size, report.providers.length, 'clientId is the key, so it must be unique');
  assert.equal(byId.get('openai').installed, true);
  assert.equal(byId.get('anthropic').installed, false);
  assert.deepEqual(
    report.providers.filter((p) => p.installed && p.localCli).map((p) => p.clientId),
    ['openai'],
  );
});
