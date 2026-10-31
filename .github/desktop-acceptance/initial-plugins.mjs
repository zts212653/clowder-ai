import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// These dependency-bearing builtins are enabled by the official initial selection.
export const REQUIRED_INITIAL_PLUGINS = Object.freeze([
  'official.companion.personal-chrome',
  'official.enterprise-workflow',
  'official.collective-connector',
]);

export function initialPluginStates(value) {
  assert.ok(Array.isArray(value?.plugins), 'Invalid installed plugin response');
  return REQUIRED_INITIAL_PLUGINS.map((pluginId) => {
    const matches = value.plugins.filter((plugin) => plugin.pluginId === pluginId);
    assert.ok(matches.length <= 1, `Duplicate installed plugin identity: ${pluginId}`);
    const plugin = matches[0];
    return {
      pluginId,
      pluginInstanceId: plugin?.pluginInstanceId ?? null,
      installedVersion: plugin?.installedVersion ?? null,
      packageDigest: plugin?.packageDigest ?? null,
      artifact: plugin?.artifact ?? 'absent',
      intent: plugin?.intent ?? 'disabled',
      live: plugin?.live ?? 'stopped',
      activationFailed: plugin?.activationFailed === true,
    };
  });
}

export async function waitForInitialPlugins({
  read,
  observe = () => {},
  now = Date.now,
  pause = delay,
  timeoutMs = 180000,
}) {
  const deadline = now() + timeoutMs;
  let states = [];
  while (now() < deadline) {
    states = initialPluginStates(await read());
    observe(states);
    assert.ok(
      !states.some((plugin) => plugin.activationFailed || plugin.live === 'crashed'),
      `Default plugin activation failed: ${JSON.stringify(states)}`,
    );
    if (
      states.every(
        (plugin) =>
          plugin.artifact === 'installed' &&
          plugin.intent === 'enabled' &&
          plugin.live === 'running' &&
          plugin.pluginInstanceId &&
          plugin.installedVersion &&
          plugin.packageDigest,
      )
    ) {
      return { expectedPluginIds: [...REQUIRED_INITIAL_PLUGINS], plugins: states, defaultInitialPluginsReady: true };
    }
    await pause(250);
  }
  throw new Error(`Default plugins did not become installed, enabled and running: ${JSON.stringify(states)}`);
}

export function assertNoInitialPluginSetupFailure(log) {
  assert.ok(
    !/BuiltinPluginPackageMaterializationError|Initial plugin setup pending/.test(log),
    'Installed distribution logged a default plugin setup failure',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], '--logs');
  assert.equal(process.argv.length, 4);
  const directory = path.resolve(process.argv[3]);
  const logs = fs.readdirSync(directory).filter((name) => /^(?:app-|portable-first-run).*\.log$/.test(name));
  assert.ok(logs.length > 0, 'No actual application logs captured');
  for (const name of logs) assertNoInitialPluginSetupFailure(fs.readFileSync(path.join(directory, name), 'utf8'));
  console.log(JSON.stringify({ actualStartupLogsChecked: logs.length, initialPluginSetupFailures: 0 }));
}
