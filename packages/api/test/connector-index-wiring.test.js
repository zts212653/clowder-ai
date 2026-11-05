import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

describe('F202 connector action ownership in production', () => {
  test('installed package actions use the shared runtime inventory, configuration and supervisor', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const installedPluginOperations = new InstalledPluginOperations({');
    const end = source.indexOf('\n  });', start);

    assert.notEqual(start, -1, 'index.ts must compose installed plugin operations');
    assert.notEqual(end, -1, 'installed plugin operation dependencies must be present');

    const block = source.slice(start, end);
    for (const [key, dependency] of [
      ['inventory', 'pluginRuntime.inventoryStore'],
      ['configuration', 'pluginManagerRuntime.configuration'],
      ['invocation', 'pluginRuntime.supervisor'],
    ]) {
      assert.ok(
        new RegExp(`\\b${key}:\\s*${dependency.replaceAll('.', '\\.')}\\s*,`).test(block),
        `installed package actions must receive ${key} from ${dependency}`,
      );
    }
    assert.match(source, /app\.register\(pluginOperationRoutes,\s*\{\s*operations:\s*installedPluginOperations\s*\}\)/);
    assert.doesNotMatch(source, /wireGatewayHooks|connectorHubRoutes/);
  });
});
