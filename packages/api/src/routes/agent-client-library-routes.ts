import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import {
  inspectAcpBootstrapDirectory,
  isExplicitAcpBootstrapRoot,
} from '../domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-inspect.js';
import type { SessionImplementationRegistry } from '../domains/cats/services/agents/session-contract/implementation-registry.js';
import {
  AGENT_PROVIDER_DECLARATION_FILE,
  parseAgentProviderDeclaration,
} from '../domains/cats/services/agents/session-contract/plugin-agent-provider.js';
import { resolveAgentClientLibrary } from '../domains/plugin/declared/agent-client-library.js';
import { readDeclaration } from '../domains/plugin/declared/declared-agent-session-providers.js';
import { resolvePackageFile } from '../domains/plugin/declared/declared-resource-paths.js';
import type { VerifiedPluginPackageLocator } from '../domains/plugin/external-runtime/types.js';
import type { PluginInventoryStore } from '../domains/plugin/host-inventory/ports.js';
import type { PluginRuntimeConfigurationPort } from '../domains/plugin/manifest-configuration-projection.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

export function registerAgentClientLibraryRoutes(
  app: FastifyInstance,
  input: {
    inventory: PluginInventoryStore;
    packages: VerifiedPluginPackageLocator;
    configuration: Pick<PluginRuntimeConfigurationPort, 'readConfig'>;
    registry: SessionImplementationRegistry;
  },
): void {
  app.post('/api/agent-providers/bootstrap-check', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return pluginAccessError(reply, access);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'root'))
      return reply.code(400).send({ error: 'Invalid directory check' });
    const root = (body as { root?: unknown }).root;
    if (root !== undefined && (typeof root !== 'string' || !isExplicitAcpBootstrapRoot(root))) {
      return reply.code(400).send({ error: '引导目录必须是本机绝对路径。' });
    }
    return inspectAcpBootstrapDirectory(root);
  });
  app.get('/api/agent-providers', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    const snapshot = await input.inventory.snapshot();
    const libraries = [];
    for (const instance of snapshot.instances.filter((instance) => instance.lifecycleState === 'installed')) {
      const record = snapshot.packages.find((record) => record.packageDigest === instance.packageDigest);
      if (!record?.manifest) continue;
      let located: Awaited<ReturnType<VerifiedPluginPackageLocator['resolveInstalledPackage']>> | undefined;
      let configurationKey: string | null = null;
      try {
        located = await input.packages.resolveInstalledPackage(record.packageDigest);
        if (!isDeepStrictEqual(located.manifest, record.manifest)) throw new Error('ACP 插件包权威不一致');
        await located.verifyIntegrity();
        let raw: unknown;
        try {
          raw = await readDeclaration(
            await resolvePackageFile(located.rootDir, AGENT_PROVIDER_DECLARATION_FILE, 'Agent provider declaration'),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        await located.verifyIntegrity();
        const parsed = parseAgentProviderDeclaration(raw, { packageRoot: located.rootDir });
        if (!parsed.ok) throw new Error(parsed.reason);
        configurationKey = 'configurationKey' in parsed.declaration ? parsed.declaration.configurationKey : null;
        const profiles =
          'configurationKey' in parsed.declaration
            ? await resolveAgentClientLibrary({
                declaration: parsed.declaration,
                admission: {
                  instance,
                  packageRecord: { ...record, manifest: record.manifest },
                },
                packageRoot: located.rootDir,
                configuration: input.configuration,
              })
            : [parsed.declaration];
        libraries.push({
          pluginId: instance.pluginId,
          presets: 'configurationKey' in parsed.declaration ? (parsed.declaration.presets ?? []) : [],
          configurationKey,
          clients: profiles.map((profile) => ({
            id: profile.id,
            name: profile.name ?? profile.id,
            ref: `plugin:${instance.pluginId}/${profile.id}`,
            available: input.registry.has({ pluginId: instance.pluginId, contributionId: profile.id }),
          })),
        });
      } catch (error) {
        libraries.push({
          pluginId: instance.pluginId,
          configurationKey,
          clients: [],
          error: error instanceof Error ? error.message : 'ACP 插件目录读取失败',
        });
      } finally {
        await located?.release();
      }
    }
    return { libraries };
  });
}
