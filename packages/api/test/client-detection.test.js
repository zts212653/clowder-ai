/**
 * client-detection unit tests — LL-055 src-extension regression guards.
 *
 * Locks in: detection MUST NOT spawn agent runtimes. Only PATH existence
 * probes. A re-introduction of `versionCmd: 'opencode version'` (or any
 * other CLI-launching probe) would leak PPID=1 zombies under SIGTERM
 * unresponsive children — the original incident on 2026-05-08.
 *
 * Also locks in the coverage fix: this module used to probe `gemini` while the catalog runs
 * `agy`, so `google` was reported missing on machines where it was installed.
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const { detectAvailableClients, getInstalledClients, getCliSpecsForTest } = await import(
  '../dist/domains/cats/services/first-run-quest/client-detection.js'
);

/** Resolver stub: only the named commands resolve. */
function resolverFor(resolvable) {
  const probed = [];
  const resolveCommand = mock.fn((command) => {
    probed.push(command);
    return resolvable.includes(command) ? `/usr/local/bin/${command}` : null;
  });
  return { resolveCommand, probed };
}

test('detectAvailableClients probes every candidate via injected resolveCommand', async () => {
  const { resolveCommand, probed } = resolverFor(['claude', 'codex']);

  const result = await detectAvailableClients({ resolveCommand });

  assert.equal(result.length, 5, 'five local CLI clients are detected');
  // `agy` is the real google binary (four members run it); `gemini` is the legacy fallback.
  // `kimi-cli` is probed before `kimi` because KimiAgentService treats it as legacy-first.
  assert.deepEqual(probed.sort(), ['agy', 'claude', 'codex', 'gemini', 'kimi', 'kimi-cli', 'opencode']);
  const installed = result.filter((c) => c.installed).map((c) => c.client);
  assert.deepEqual(installed.sort(), ['claude', 'codex']);
  const google = result.find((c) => c.provider === 'google');
  assert.equal(google.cli, 'agy', 'google is reported under its agy binary, not gemini');
});

test('a machine with only the legacy gemini binary still counts as google', async () => {
  const { resolveCommand } = resolverFor(['gemini']);
  const result = await detectAvailableClients({ resolveCommand });
  const google = result.find((c) => c.provider === 'google');
  assert.equal(google.installed, true, 'legacy gemini install must not be reported missing');
  assert.equal(google.cli, 'gemini');
});

test('getInstalledClients filters to installed only', async () => {
  const { resolveCommand } = resolverFor(['opencode']);
  const installed = await getInstalledClients({ resolveCommand });
  assert.equal(installed.length, 1);
  assert.equal(installed[0].client, 'opencode');
});

test('detectAvailableClients tolerates probe rejection on individual CLIs', async () => {
  const resolveCommand = mock.fn((command) => {
    if (command === 'opencode') {
      // Simulate a probe that throws — must not bubble up or block others.
      throw new Error('synthetic probe failure');
    }
    return command === 'claude' ? '/usr/local/bin/claude' : null;
  });

  const result = await detectAvailableClients({ resolveCommand });
  assert.equal(result.length, 5);
  const opencode = result.find((c) => c.client === 'opencode');
  assert.equal(opencode?.installed, false, 'probe failure must downgrade to not-installed, never propagate');
  const claude = result.find((c) => c.client === 'claude');
  assert.equal(claude?.installed, true, 'one failing provider must not blank the report');
});

test('NO spec carries a version-fetching command field — LL-055 src-extension regression guard', () => {
  const specs = getCliSpecsForTest();
  assert.equal(specs.length, 5);
  for (const spec of specs) {
    // Hard-fail if anyone reintroduces `versionCmd`, `versionArgs`, or any
    // field name that hints at spawning the CLI to interrogate it.
    const forbiddenFields = Object.keys(spec).filter((k) => /version|--version|spawn/i.test(k));
    assert.deepEqual(
      forbiddenFields,
      [],
      `spec ${spec.client} must not carry version-spawning fields (got: ${forbiddenFields.join(', ')})`,
    );
    // Required fields still present.
    assert.equal(typeof spec.client, 'string');
    assert.equal(typeof spec.cli, 'string');
    assert.equal(typeof spec.label, 'string');
    assert.equal(typeof spec.provider, 'string');
    assert.ok(Array.isArray(spec.commands) && spec.commands.length > 0, 'commands list required');
    assert.ok('envKey' in spec, 'envKey field required');
  }
});

test('hasApiKey reflects env var presence', async () => {
  const { resolveCommand } = resolverFor(['claude', 'opencode']);
  const result = await detectAvailableClients({
    resolveCommand,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-stub' },
  });
  const claude = result.find((c) => c.client === 'claude');
  assert.equal(claude?.hasApiKey, true, 'ANTHROPIC_API_KEY set → claude.hasApiKey=true');
  const opencode = result.find((c) => c.client === 'opencode');
  assert.equal(opencode?.hasApiKey, true, 'opencode shares ANTHROPIC_API_KEY');
  const codex = result.find((c) => c.client === 'codex');
  assert.equal(codex?.hasApiKey, false, 'OPENAI_API_KEY unset → codex.hasApiKey=false');
});

test('a missing CLI carries an actionable install hint', async () => {
  const { resolveCommand } = resolverFor([]);
  const result = await detectAvailableClients({ resolveCommand });
  const claude = result.find((c) => c.client === 'claude');
  assert.match(claude.installHint, /npm install -g @anthropic-ai\/claude-code/);
  assert.match(claude.reason, /未在本机找到/);
  assert.match(claude.reason, /CAT_ANTHROPIC_PATH/, 'reason names the path escape hatch');
});
