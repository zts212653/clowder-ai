import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { RepositoryPluginManagerCompatibilityProvider } from '../dist/domains/plugin/manager/plugin-manager-compatibility.js';
import { PluginRegistry } from '../dist/domains/plugin/PluginRegistry.js';

test('Manager edits complete non-sensitive values while secrets and legacy reads remain masked', async () => {
  const registry = new PluginRegistry(resolve('src/plugins'));
  registry.scan();
  const manifest = registry.getManifest('github');
  assert.ok(manifest);
  const env = {
    GITHUB_SETUP_NOISE_BOT_LOGINS: 'acceptance-bot,second-bot',
    GITHUB_TOKEN: 'test-only-secret-value',
    GITHUB_MCP_PAT: 'test-only-mcp-secret',
  };
  const legacy = registry.getPluginInfo(manifest, null, env);
  assert.equal(legacy.config.find((f) => f.envName === 'GITHUB_SETUP_NOISE_BOT_LOGINS').currentValue, 'accept****');
  const provider = new RepositoryPluginManagerCompatibilityProvider(() => [
    registry.getPluginInfo(manifest, null, env, { includeNonSensitiveValues: true }),
  ]);
  const [row] = await provider.list();
  assert.equal(
    row.configFields.find((f) => f.envName === 'GITHUB_SETUP_NOISE_BOT_LOGINS').currentValue,
    env.GITHUB_SETUP_NOISE_BOT_LOGINS,
  );
  assert.equal(row.configFields.find((f) => f.envName === 'GITHUB_TOKEN').currentValue, '••••••');
  assert.equal(row.configFields.find((f) => f.envName === 'GITHUB_MCP_PAT').currentValue, '••••••');
  assert.equal(JSON.stringify(row).includes('test-only-'), false);
});
