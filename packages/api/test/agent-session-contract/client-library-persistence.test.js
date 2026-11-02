import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCatConfig, toAllCatConfigs } from '../../dist/config/cat-config-loader.js';
import { updateRuntimeCat } from '../../dist/config/runtime-cat-catalog.js';
import { resolveMemberSessionRef } from '../../dist/domains/cats/services/agents/session-contract/plugin-agent-provider.js';
import { selectSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';

for (const carrier of ['acp', 'cli'])
  test(`manual ${carrier} choice survives disk reload and overrides both old bindings`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'client-binding-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    await mkdir(join(root, '.cat-cafe'));
    const path = join(root, '.cat-cafe/cat-catalog.json');
    const nested = 'plugin:old/nested';
    const catalog = {
      version: 1,
      breeds: [
        {
          id: 'test',
          catId: 'test',
          name: 'Test',
          displayName: 'Test',
          avatar: '/test.png',
          color: { primary: '#123456', secondary: '#ffffff' },
          mentionPatterns: ['@test'],
          roleDescription: 'Test',
          defaultVariantId: 'default',
          variants: [
            {
              id: 'default',
              clientId: 'acp',
              carrier: 'acp',
              configurationSource: 'native_tool',
              defaultModel: '',
              mcpSupport: false,
              cli: { command: 'claude', outputFormat: 'stream-json' },
              acp: { agentProvider: nested, command: 'node', startupArgs: [] },
              agentProvider: 'plugin:official.acp-clients/dsh',
            },
          ],
        },
      ],
    };
    await writeFile(path, JSON.stringify(catalog));
    updateRuntimeCat(root, 'test', { agentProvider: null, carrier, clientId: carrier === 'cli' ? 'anthropic' : 'acp' });
    const reloaded = toAllCatConfigs(loadCatConfig(path)).test;
    assert.equal(reloaded.agentProvider, null);
    assert.equal(reloaded.carrier, carrier);
    const ref = resolveMemberSessionRef(reloaded.agentProvider, { pluginId: 'legacy', contributionId: 'env' }, nested);
    assert.equal(
      selectSessionAgentService(
        ref,
        () => assert.fail('old plugin intercepted the explicit manual choice'),
        () => 'manual',
      ),
      'manual',
    );
  });
