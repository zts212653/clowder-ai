import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('production has one connector runtime owner: installed plugin composition', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  for (const retired of [
    'startConnectorGateway',
    'restartConnectorGateway',
    'createConnectorReloadSubscriber',
    'connectorHubRoutes',
    'connectorPluginRoutes',
    'wireGatewayHooks',
  ]) {
    assert.equal(source.includes(retired), false, `${retired} must not start or administer a second IM implementation`);
  }
  assert.match(source, /createPluginManagerRuntimeComposition/);
  assert.match(source, /registerGitHubRepoWebhook/);
  assert.match(source, /limbOutboundDelivery\.deliver/);
});
