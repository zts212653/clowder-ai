import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

describe('F240 connector index wiring', () => {
  test('wireGatewayHooks exposes action lifecycle dependencies to connectorHubRoutes', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('function wireGatewayHooks');
    const end = source.indexOf('  }\n\n  let connectorGatewayHandle', start);

    assert.notEqual(start, -1, 'index.ts must define wireGatewayHooks');
    assert.notEqual(end, -1, 'index.ts must keep connector gateway handle after wireGatewayHooks');

    const block = source.slice(start, end);
    for (const key of ['pluginRegistry', 'adapterRegistry', 'activateConnector', 'deactivateConnector']) {
      assert.ok(
        new RegExp(`\\)\\.${key}\\s*=\\s*handle\\.${key}`).test(block),
        `REGRESSION: connectorHubRoutes must receive ${key} from ConnectorGatewayHandle`,
      );
    }
  });
});
