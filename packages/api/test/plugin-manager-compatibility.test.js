import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PluginManagerCompatibilityAdapter,
  RepositoryPluginManagerCompatibilityProvider,
} from '../dist/domains/plugin/index.js';

describe('F202 Plugin Manager migration compatibility', () => {
  it('projects current repository plugins as read-only Manager rows and excludes migrated identities', async () => {
    const provider = new RepositoryPluginManagerCompatibilityProvider(
      async () => [
        {
          id: 'github',
          name: 'GitHub',
          version: '1.0.0',
          description: 'Repository automation',
          icon: 'github',
          iconBg: '#24292e',
          docsUrl: 'https://cli.github.com/manual/gh_auth_login',
          setupSteps: ['Log in with gh'],
          status: 'enabled',
          configured: true,
          config: [],
          resources: [{ type: 'schedule', name: 'repo-scan', enabled: true }],
          hasHealthCheck: false,
        },
        {
          id: 'video-analysis',
          name: 'Legacy video analysis',
          version: '1.0.0',
          status: 'configured',
          configured: true,
          config: [],
          resources: [{ type: 'mcp', name: 'video-analysis-toolset', enabled: false }],
          hasHealthCheck: false,
        },
      ],
      { loadSuppressedPluginIds: async () => ['video-analysis'] },
    );

    const rows = await provider.list();

    assert.deepEqual(rows, [
      {
        pluginId: 'github',
        displayName: 'GitHub',
        version: '1.0.0',
        description: 'Repository automation',
        icon: 'github',
        iconBg: '#24292e',
        publisher: 'Clowder AI',
        sourceAdapter: 'repository-local',
        configured: true,
        enabled: true,
        live: true,
        docsUrl: 'https://cli.github.com/manual/gh_auth_login',
        setupSteps: ['Log in with gh'],
        configFields: [],
        capabilities: [
          {
            id: 'plugin:github:repo-scan',
            kind: 'schedule',
            name: 'repo-scan',
            active: true,
          },
        ],
      },
    ]);
  });

  it('projects repository-local and connector rows without inventing Host mutation authority', async () => {
    const adapter = new PluginManagerCompatibilityAdapter([
      {
        list: async () => [
          {
            pluginId: 'github',
            displayName: 'GitHub',
            version: '1.2.3',
            description: 'Repository automation',
            sourceAdapter: 'repository-local',
            configured: true,
            enabled: true,
            live: true,
            docsUrl: 'https://docs.example/github',
            setupSteps: ['Create a token'],
            configFields: [
              {
                type: 'input',
                envName: 'GITHUB_TOKEN',
                label: 'Token',
                required: true,
                sensitive: true,
                currentValue: '••••••',
              },
            ],
            capabilities: [{ id: 'repo-scan', kind: 'schedule', name: 'Repository scan', active: true }],
          },
        ],
      },
      {
        list: async () => [
          {
            pluginId: 'telegram',
            displayName: 'Telegram',
            version: '1.0.0',
            sourceAdapter: 'connector',
            configured: false,
            enabled: false,
            live: false,
            configFields: [],
            capabilities: [{ id: 'messaging', kind: 'connector', name: 'Messaging', active: false }],
          },
        ],
      },
    ]);

    const rows = await adapter.list();

    assert.deepEqual(
      rows.map((row) => row.pluginId),
      ['github', 'telegram'],
    );
    assert.deepEqual(rows[0].source, {
      kind: 'compatibility',
      adapter: 'repository-local',
      packageName: 'repository-local:github',
      trust: 'first-party',
    });
    assert.equal(rows[0].pluginInstanceId, null);
    assert.equal(rows[0].lifecycleRevision, null);
    assert.deepEqual(rows[0].actions, {
      install: false,
      setEnabled: false,
      uninstall: false,
      blockingReasons: ['compatibility-read-only'],
    });
    assert.equal(rows[0].capabilities[0].active, true);
    assert.equal(rows[0].configFields[0].currentValue, '••••••');
    assert.deepEqual(rows[1].source, {
      kind: 'compatibility',
      adapter: 'connector',
      packageName: 'connector:telegram',
      trust: 'local-trusted',
    });
    assert.equal(rows[1].publisher, 'Local Host');
    assert.equal(rows[1].config, 'incomplete');
    assert.equal(rows[1].intent, 'disabled');
  });

  it('deduplicates the same transitional identity at the compatibility boundary', async () => {
    const adapter = new PluginManagerCompatibilityAdapter([
      {
        list: async () => [
          {
            pluginId: 'shared',
            displayName: 'Repository copy',
            version: '1.0.0',
            sourceAdapter: 'repository-local',
            configured: true,
            enabled: false,
            live: false,
            configFields: [],
            capabilities: [],
          },
        ],
      },
      {
        list: async () => [
          {
            pluginId: 'shared',
            displayName: 'Connector copy',
            version: '1.0.0',
            sourceAdapter: 'connector',
            configured: true,
            enabled: true,
            live: true,
            configFields: [],
            capabilities: [],
          },
        ],
      },
    ]);

    const rows = await adapter.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].displayName, 'Repository copy');
  });
});
