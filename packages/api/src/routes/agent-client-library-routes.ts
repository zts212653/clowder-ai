import type { FastifyInstance } from 'fastify';
import {
  inspectAcpBootstrapDirectory,
  isExplicitAcpBootstrapRoot,
} from '../domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-inspect.js';
import type { SessionImplementationRegistry } from '../domains/cats/services/agents/session-contract/implementation-registry.js';
import { readAgentClientProfileList } from '../domains/cats/services/agents/session-contract/plugin-agent-provider.js';
import { readAgentClientLibraryConfiguration } from '../domains/plugin/declared/agent-client-library.js';
import type { PluginInventoryStore } from '../domains/plugin/host-inventory/ports.js';
import type { PluginRuntimeConfigurationPort } from '../domains/plugin/manifest-configuration-projection.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

export function registerAgentClientLibraryRoutes(
  app: FastifyInstance,
  input: {
    inventory: PluginInventoryStore;
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
      const metadata = record.agentClientMetadata;
      if (metadata === null) continue;
      let configurationKey: string | null = null;
      try {
        if (metadata === undefined) throw new Error('ACP 插件目录尚未登记，请修复插件或重启 Host。');
        if ('error' in metadata) throw new Error(metadata.error);
        const { catalog } = metadata;
        configurationKey = catalog.configurationKey;
        let profiles = catalog.clients;
        if (configurationKey !== null) {
          const { value, ownerSaved } = await readAgentClientLibraryConfiguration({
            declaration: { configurationKey },
            admission: { instance, packageRecord: { ...record, manifest: record.manifest } },
            configuration: input.configuration,
          });
          const configured = readAgentClientProfileList(value);
          if (!ownerSaved && configured.some((profile) => profile.permissionPolicy === 'auto_allow'))
            throw new Error('ACP 权限自动允许需要 owner 显式保存选择，不能来自插件默认配置');
          profiles = configured;
        }
        libraries.push({
          pluginId: instance.pluginId,
          presets: catalog.presets,
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
      }
    }
    return { libraries };
  });
}
