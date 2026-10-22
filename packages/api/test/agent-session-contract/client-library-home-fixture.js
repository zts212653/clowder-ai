import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { createRefreshingAcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { declaredAgentSessionProviders } from '../../dist/domains/plugin/declared/declared-agent-session-providers.js';

export async function library(t, createService, { catIds = ['codex'] } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'home-client-capabilities-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await writeFile(join(rootDir, 'agent-provider.json'), JSON.stringify({ configurationKey: 'clients' }));
  const registry = new SessionImplementationRegistry();
  const ref = { pluginId: 'local.home-library', contributionId: 'first' };
  const services = new Map(
    catIds.map((catId) => {
      const service = new RegisteredSessionAgentService({ catId, ref, registry });
      return [catId, service];
    }),
  );
  const service = services.get(catIds[0]);
  const manifest = { configuration: [{ key: 'clients', kind: 'string' }] };
  const lifecycle = declaredAgentSessionProviders({
    settings: { mode: 'plugin', bindings: new Map() },
    registry,
    services,
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir,
        manifest,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
    configuration: {
      readConfig: async () =>
        JSON.stringify(['first', 'second'].map((id) => ({ id, name: id, command: 'node', startupArgs: [] }))),
    },
    createProvider: (_, { catId }) =>
      createRefreshingAcpSessionProvider({
        catId,
        scope: {},
        revision: () => 1,
        createService: () => createService(catId),
      }),
  });
  const admission = {
    instance: { pluginInstanceId: 'home-library' },
    packageRecord: { pluginId: ref.pluginId, packageDigest: 'fixture', manifest },
    effectiveGrants: ['plugin.config.read'],
  };
  return { rootDir, registry, ref, service, activate: () => lifecycle.activate(admission) };
}

export function poolFactory(t, rootDir) {
  const poolRegistry = new Map();
  const pools = new Set();
  t.after(async () => {
    await Promise.all([...pools].map((pool) => pool.closeAll()));
  });
  return {
    poolRegistry,
    pools,
    async create(catId, args = []) {
      const service = await createAcpServiceForConfig({
        projectRoot: rootDir,
        profileId: catId,
        config: {
          id: catId,
          clientId: 'acp',
          configurationSource: 'native_tool',
          defaultModel: 'fixture',
          mcpSupport: false,
        },
        effectiveModel: 'fixture',
        acpConfig: { command: 'node', startupArgs: args },
        bootstrapRoot: join(rootDir, 'bootstrap'),
        poolRegistry,
        log: { info() {}, warn() {} },
      });
      const pool = poolRegistry.get(catId);
      assert.ok(pool, 'production factory creates a real pool before any invocation');
      pools.add(pool);
      return service;
    },
  };
}
