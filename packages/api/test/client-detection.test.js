/**
 * client-detection unit tests — LL-055 src-extension regression guards.
 *
 * Locks in: detection MUST NOT spawn agent runtimes. Only PATH existence
 * probes. A re-introduction of `versionCmd: 'opencode version'` (or any
 * other CLI-launching probe) would leak PPID=1 zombies under SIGTERM
 * unresponsive children — the original incident on 2026-05-08.
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const { detectAvailableClients, getInstalledClients, getCliSpecsForTest } = await import(
  '../dist/domains/cats/services/first-run-quest/client-detection.js'
);

test('detectAvailableClients probes every spec via injected existsOnPath', async () => {
  const probedClis = [];
  const existsOnPath = mock.fn(async (cli) => {
    probedClis.push(cli);
    return cli === 'claude' || cli === 'codex';
  });

  const result = await detectAvailableClients({ existsOnPath });

  assert.equal(result.length, 6, 'six CLIs detected');
  assert.deepEqual(probedClis.sort(), ['claude', 'codex', 'dare', 'gemini', 'kimi', 'opencode']);
  // Two installed (claude + codex), four not.
  const installed = result.filter((c) => c.installed).map((c) => c.client);
  assert.deepEqual(installed.sort(), ['claude', 'codex']);
});

test('getInstalledClients filters to installed only', async () => {
  const existsOnPath = mock.fn(async (cli) => cli === 'opencode');
  const installed = await getInstalledClients({ existsOnPath });
  assert.equal(installed.length, 1);
  assert.equal(installed[0].client, 'opencode');
});

test('detectAvailableClients tolerates probe rejection on individual CLIs', async () => {
  const existsOnPath = mock.fn(async (cli) => {
    if (cli === 'opencode') {
      // Simulate a probe that throws — must not bubble up or block others.
      throw new Error('synthetic probe failure');
    }
    return true;
  });

  // The wrapping checkCli should swallow the throw and treat as not-installed,
  // so the call resolves rather than rejecting.
  const result = await detectAvailableClients({ existsOnPath });
  assert.equal(result.length, 6);
  const opencode = result.find((c) => c.client === 'opencode');
  // Either installed=false (swallowed) or the call rejected (current shape:
  // existsOnPath throws → checkCli's awaited probe throws → Promise.all rejects).
  // We pin the contract: throws become installed=false, no propagation.
  assert.equal(opencode?.installed, false, 'probe failure must downgrade to not-installed, never propagate');
});

test('NO spec carries a version-fetching command field — LL-055 src-extension regression guard', () => {
  const specs = getCliSpecsForTest();
  assert.equal(specs.length, 6);
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
    assert.ok('envKey' in spec, 'envKey field required');
  }
});

test('hasApiKey reflects env var presence', async () => {
  const existsOnPath = mock.fn(async () => true);
  const original = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-test-stub';
    const result = await detectAvailableClients({ existsOnPath });
    const claude = result.find((c) => c.client === 'claude');
    assert.equal(claude?.hasApiKey, true, 'ANTHROPIC_API_KEY set → claude.hasApiKey=true');
    const opencode = result.find((c) => c.client === 'opencode');
    assert.equal(opencode?.hasApiKey, true, 'opencode shares ANTHROPIC_API_KEY');
    const dare = result.find((c) => c.client === 'dare');
    assert.equal(dare?.hasApiKey, false, 'dare has empty envKey → hasApiKey=false');
  } finally {
    if (original === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = original;
    }
  }
});
