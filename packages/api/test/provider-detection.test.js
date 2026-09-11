/**
 * provider-detection unit tests.
 *
 * Guards the two decisions that make this detector safe to run inside the API process:
 *   1. detection never spawns a CLI unless version probing is explicitly enabled (LL-055);
 *   2. a broken `CAT_<CLIENT>_PATH` override is a hard error, never a silent fall-through to
 *      whatever PATH happens to resolve — an operator who pinned a binary must not be handed
 *      a different one.
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const {
  VERSION_PROBE_ENV,
  availabilityByClientId,
  detectProviderAvailability,
  installedProviders,
  isVersionProbeEnabled,
} = await import('../dist/domains/cats/services/agents/providers/provider-detection.js');

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
  const installed = installedProviders(report);
  assert.equal(
    installed.some((p) => !p.localCli),
    false,
    'a bridged client must never count as an installed local CLI',
  );
});

test('never spawns a CLI unless version probing is opted in (LL-055)', async () => {
  const probeVersion = mock.fn(async () => 'v9.9.9');
  const report = await detectProviderAvailability({
    resolveCommand: (command) => `/usr/local/bin/${command}`,
    env: {},
  });
  assert.equal(report.versionProbeEnabled, false);

  const withProbe = await detectProviderAvailability({
    resolveCommand: (command) => `/usr/local/bin/${command}`,
    probeVersion,
    env: {},
  });
  assert.equal(withProbe.versionProbeEnabled, false);
  assert.equal(probeVersion.mock.callCount(), 0, 'default detection must not fork any CLI');
  assert.equal(byId(withProbe, 'anthropic').version, undefined);

  // And the same stub is never reached for the path-only providers even when enabled.
  const enabled = await detectProviderAvailability({
    resolveCommand: (command) => `/usr/local/bin/${command}`,
    probeVersion,
    env: { [VERSION_PROBE_ENV]: '1' },
  });
  assert.equal(enabled.versionProbeEnabled, true);
  assert.equal(byId(enabled, 'anthropic').version, 'v9.9.9');
  assert.equal(byId(enabled, 'openai').version, 'v9.9.9');
  assert.equal(
    byId(enabled, 'kimi').version,
    undefined,
    'kimi is path-only: probing it is exactly the LL-055 zombie case',
  );
  assert.equal(probeVersion.mock.callCount(), 2);
});

test('an unreadable version downgrades to no version, never to not-installed', async () => {
  const report = await detectProviderAvailability({
    resolveCommand: (command) => `/usr/local/bin/${command}`,
    probeVersion: async () => undefined,
    env: { [VERSION_PROBE_ENV]: '1' },
  });

  const anthropic = byId(report, 'anthropic');
  assert.equal(anthropic.installed, true, 'a failed version probe is transient, not a verdict');
  assert.equal(anthropic.status, 'configured');
  assert.equal(anthropic.version, undefined);
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

test('lookup helpers key by clientId', async () => {
  const report = await detectProviderAvailability({
    resolveCommand: (command) => (command === 'codex' ? '/usr/local/bin/codex' : null),
    env: {},
  });
  const map = availabilityByClientId(report);
  assert.equal(map.get('openai').installed, true);
  assert.equal(map.get('anthropic').installed, false);
  assert.deepEqual(
    installedProviders(report).map((p) => p.clientId),
    ['openai'],
  );
});

test('isVersionProbeEnabled only accepts the exact opt-in value', () => {
  assert.equal(isVersionProbeEnabled({}), false);
  assert.equal(isVersionProbeEnabled({ [VERSION_PROBE_ENV]: '0' }), false);
  assert.equal(isVersionProbeEnabled({ [VERSION_PROBE_ENV]: 'true' }), false);
  assert.equal(isVersionProbeEnabled({ [VERSION_PROBE_ENV]: '1' }), true);
});
