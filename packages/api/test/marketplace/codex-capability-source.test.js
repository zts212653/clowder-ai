// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('collectCodexCapabilitySource', () => {
  it('uses only the six stable read methods and normalizes provider-owned lifecycle evidence', async () => {
    const calls = [];
    const responses = new Map([
      [
        'skills/list',
        {
          data: [
            {
              cwd: '/workspace',
              errors: [],
              skills: [
                {
                  name: 'review-helper',
                  description: 'Review safely',
                  enabled: true,
                  path: '/workspace/.codex/skills/review-helper/SKILL.md',
                  scope: 'repo',
                },
              ],
            },
          ],
        },
      ],
      [
        'app/list',
        {
          data: [
            {
              id: 'calendar',
              name: 'Calendar',
              description: 'Calendar connector',
              isAccessible: true,
              isEnabled: true,
              installUrl: 'https://example.invalid/calendar/install',
              branding: { developer: 'OpenAI', isDiscoverableApp: true },
              appMetadata: { version: '3.2.1' },
            },
          ],
          nextCursor: null,
        },
      ],
      ['app/installed', { apps: [{ id: 'calendar', enabled: true, callable: true, runtimeName: 'Calendar' }] }],
      [
        'plugin/list',
        {
          featuredPluginIds: ['provider-kit'],
          marketplaceLoadErrors: [],
          marketplaces: [
            {
              name: 'official',
              plugins: [
                {
                  id: 'provider-kit',
                  name: 'Provider Kit',
                  authPolicy: 'ON_USE',
                  installPolicy: 'AVAILABLE',
                  installed: false,
                  enabled: false,
                  source: { type: 'remote' },
                  version: '1.4.0',
                  interface: {
                    capabilities: ['skills', 'mcp'],
                    shortDescription: 'Provider utilities',
                    developerName: 'OpenAI',
                    screenshotUrls: [],
                    screenshots: [],
                  },
                },
              ],
            },
          ],
        },
      ],
      ['plugin/installed', { marketplaceLoadErrors: [], marketplaces: [] }],
      [
        'mcpServerStatus/list',
        {
          data: [
            {
              name: 'memory',
              authStatus: 'oAuth',
              runtimeStatus: 'connected',
              pluginId: 'provider-kit',
              serverInfo: { name: 'Memory', version: '2.0.0', description: 'Memory server' },
              tools: { search: { name: 'search', inputSchema: {} } },
              resources: [{ name: 'guide', uri: 'memory://guide' }],
              resourceTemplates: [{ name: 'item', uriTemplate: 'memory://item/{id}' }],
            },
          ],
          nextCursor: null,
        },
      ],
    ]);

    const { collectCodexCapabilitySource } = await import(
      '../../dist/domains/cats/services/agents/providers/CodexAppServerCapabilitySource.js'
    );
    const snapshot = await collectCodexCapabilitySource({
      cwd: '/workspace',
      providerVersion: '0.149.1',
      observedAt: '2026-09-02T17:00:00.000Z',
      request: async (method, params) => {
        calls.push([method, params]);
        return responses.get(method);
      },
    });

    assert.deepEqual(
      calls.map(([method]) => method),
      ['skills/list', 'app/list', 'app/installed', 'plugin/list', 'plugin/installed', 'mcpServerStatus/list'],
    );
    assert.equal(snapshot.availability, 'live');
    assert.equal(snapshot.providerVersion, '0.149.1');
    assert.equal(snapshot.artifacts.length, 4);
    assert.deepEqual(
      snapshot.artifacts.map((artifact) => artifact.kind),
      ['skill', 'app', 'plugin', 'mcp_server'],
    );
    assert.deepEqual(snapshot.artifacts.find((artifact) => artifact.kind === 'app')?.lifecycle, {
      installed: true,
      enabled: true,
      accessible: true,
      callable: true,
      maturity: 'experimental',
    });
    assert.deepEqual(snapshot.artifacts.find((artifact) => artifact.kind === 'mcp_server')?.lifecycle, {
      installed: true,
      enabled: true,
      authStatus: 'oAuth',
      runtimeStatus: 'connected',
      toolCount: 1,
      resourceCount: 1,
      resourceTemplateCount: 1,
      pluginId: 'provider-kit',
    });
    assert.equal(snapshot.artifacts.find((artifact) => artifact.kind === 'mcp_server')?.trustLevel, 'community');
  });

  it('bounds malformed/oversized provider data and degrades instead of throwing', async () => {
    const { collectCodexCapabilitySource } = await import(
      '../../dist/domains/cats/services/agents/providers/CodexAppServerCapabilitySource.js'
    );
    const snapshot = await collectCodexCapabilitySource({
      cwd: '/workspace',
      providerVersion: '0.149.1',
      observedAt: '2026-09-02T17:00:00.000Z',
      request: async (method) => {
        if (method === 'skills/list') {
          return {
            data: [
              {
                cwd: '/workspace',
                errors: [{ path: '/secret/path', message: 'x'.repeat(5_000) }],
                skills: [{ name: 'x'.repeat(1_000), description: 'y'.repeat(10_000), enabled: true }],
              },
            ],
          };
        }
        if (method === 'app/list') throw new Error('provider included a secret: should-not-leak');
        return {};
      },
    });

    assert.equal(snapshot.availability, 'degraded');
    assert.ok(snapshot.issues.length > 0);
    assert.ok(snapshot.issues.every((issue) => issue.length <= 200));
    assert.ok(snapshot.issues.every((issue) => !issue.includes('should-not-leak')));
    assert.ok(snapshot.issues.includes('app/list unavailable'));
    assert.ok(!snapshot.issues.some((issue) => /app\/list.*malformed/i.test(issue)));
    assert.ok(snapshot.artifacts.every((artifact) => artifact.id.length <= 160));
    assert.ok(snapshot.artifacts.every((artifact) => artifact.description.length <= 500));
  });

  it('stops reading provider artifacts at the shared ingestion budget and reports truncation', async () => {
    const { collectCodexCapabilitySource } = await import(
      '../../dist/domains/cats/services/agents/providers/CodexAppServerCapabilitySource.js'
    );
    const skills = Array.from({ length: 401 }, (_, index) => ({
      name: `skill-${index}`,
      description: 'bounded',
      enabled: true,
      scope: 'repo',
    }));
    Object.defineProperty(skills[400], 'name', {
      get() {
        throw new Error('the 401st skill must never be read');
      },
    });

    const snapshot = await collectCodexCapabilitySource({
      cwd: '/workspace',
      providerVersion: '0.153.3',
      request: async (method) =>
        method === 'skills/list' ? { data: [{ cwd: '/workspace', errors: [], skills }] } : {},
    });

    assert.equal(snapshot.artifacts.length, 400);
    assert.equal(snapshot.availability, 'degraded');
    assert.ok(snapshot.issues.some((issue) => /skills.*truncated.*400/i.test(issue)));
  });

  it('bounds installed app and plugin lookup ingestion before building Maps or Sets', async () => {
    const { collectCodexCapabilitySource } = await import(
      '../../dist/domains/cats/services/agents/providers/CodexAppServerCapabilitySource.js'
    );
    const installedApps = Array.from({ length: 401 }, (_, index) => ({ id: `app-${index}` }));
    Object.defineProperty(installedApps[400], 'id', {
      get() {
        throw new Error('the 401st installed app must never be read');
      },
    });
    const installedPlugins = Array.from({ length: 401 }, (_, index) => ({ id: `plugin-${index}` }));
    Object.defineProperty(installedPlugins[400], 'id', {
      get() {
        throw new Error('the 401st installed plugin must never be read');
      },
    });

    const snapshot = await collectCodexCapabilitySource({
      cwd: '/workspace',
      providerVersion: '0.153.3',
      request: async (method) => {
        if (method === 'app/installed') return { apps: installedApps };
        if (method === 'plugin/installed') {
          return { marketplaces: [{ name: 'installed', plugins: installedPlugins }] };
        }
        return {};
      },
    });

    assert.equal(snapshot.availability, 'degraded');
    assert.ok(snapshot.issues.some((issue) => /installed apps.*truncated.*400/i.test(issue)));
    assert.ok(snapshot.issues.some((issue) => /installed plugins.*truncated.*400/i.test(issue)));
  });

  it('keeps long provider identities distinct while bounding public artifact ids', async () => {
    const { collectCodexCapabilitySource } = await import(
      '../../dist/domains/cats/services/agents/providers/CodexAppServerCapabilitySource.js'
    );
    const common = 'x'.repeat(300);
    const snapshot = await collectCodexCapabilitySource({
      cwd: '/workspace',
      providerVersion: '0.153.0',
      request: async (method) =>
        method === 'app/list'
          ? {
              data: [
                { id: common + 'a', name: 'First' },
                { id: common + 'b', name: 'Second' },
              ],
            }
          : {},
    });

    const apps = snapshot.artifacts.filter((artifact) => artifact.kind === 'app');
    assert.equal(apps.length, 2);
    assert.notEqual(apps[0].id, apps[1].id);
    assert.ok(apps.every((artifact) => artifact.id.length <= 160));
  });

  it('does not invent MCP trust or enablement from an unknown provider runtime status', async () => {
    const { collectCodexCapabilitySource } = await import(
      '../../dist/domains/cats/services/agents/providers/CodexAppServerCapabilitySource.js'
    );
    const snapshot = await collectCodexCapabilitySource({
      cwd: '/workspace',
      providerVersion: '0.153.0',
      request: async (method) =>
        method === 'mcpServerStatus/list'
          ? { data: [{ name: 'future-server', runtimeStatus: 'futureState', authStatus: 'unknown' }] }
          : {},
    });

    const server = snapshot.artifacts.find((artifact) => artifact.kind === 'mcp_server');
    assert.equal(server?.trustLevel, 'community');
    assert.equal(server?.lifecycle?.runtimeStatus, 'futureState');
    assert.equal(server?.lifecycle?.enabled, undefined);
  });

  it('selects only an app-server Codex service as the provider source', async () => {
    const { selectCodexCapabilitySourceService } = await import(
      '../../dist/domains/cats/services/agents/providers/CodexAppServerCapabilitySource.js'
    );
    const wrongProvider = {
      requestNativeCapabilitySource: async () => ({ wrong: true }),
      freshnessCarrierCapability: () => ({ provider: 'other', carrier: 'app_server' }),
    };
    const codexExec = {
      requestNativeCapabilitySource: async () => ({ wrong: true }),
      freshnessCarrierCapability: () => ({ provider: 'openai_codex', carrier: 'codex_exec_json' }),
    };
    const codexAppServer = {
      requestNativeCapabilitySource: async () => ({ right: true }),
      freshnessCarrierCapability: () => ({ provider: 'openai_codex', carrier: 'codex_app_server' }),
    };

    assert.equal(selectCodexCapabilitySourceService([wrongProvider, codexExec, codexAppServer]), codexAppServer);
  });
});
