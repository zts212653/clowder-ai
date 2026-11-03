import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveByAccountRef } from '../config/account-resolver.js';
import {
  inspectAcpBootstrapDirectory,
  isExplicitAcpBootstrapRoot,
} from '../domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-inspect.js';
import type { SessionImplementationRegistry } from '../domains/cats/services/agents/session-contract/implementation-registry.js';
import {
  AGENT_PROVIDER_DECLARATION_FILE,
  type AgentProviderDeclaration,
  parseAgentProviderDeclaration,
  parsePluginAgentRef,
} from '../domains/cats/services/agents/session-contract/plugin-agent-provider.js';
import { resolveAgentClientLibrary } from '../domains/plugin/declared/agent-client-library.js';
import { readDeclaration } from '../domains/plugin/declared/declared-agent-session-providers.js';
import { resolvePackageFile } from '../domains/plugin/declared/declared-resource-paths.js';
import type { VerifiedPluginPackageLocator } from '../domains/plugin/external-runtime/types.js';
import type { PluginInventoryStore } from '../domains/plugin/host-inventory/ports.js';
import type { PluginRuntimeConfigurationPort } from '../domains/plugin/manifest-configuration-projection.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';
import { probeRuntimeCatalog } from './runtime-catalog-probe.js';
import { createCatalogCache } from './runtime-catalog-route.js';

const modelRequest = z
  .object({
    ref: z
      .string()
      .max(256)
      .transform(parsePluginAgentRef)
      .refine((value) => value !== undefined),
    model: z.string().max(512).optional(),
    accountRef: z.string().max(160).optional(),
    customStartup: z.boolean().optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

export function registerAgentClientLibraryRoutes(
  app: FastifyInstance,
  input: {
    inventory: PluginInventoryStore;
    packages: VerifiedPluginPackageLocator;
    configuration: Pick<PluginRuntimeConfigurationPort, 'readConfig'>;
    registry: SessionImplementationRegistry;
    projectRoot?: () => string;
    probe?: typeof probeRuntimeCatalog;
  },
): void {
  const cached = createCatalogCache(input.probe);
  app.post('/api/agent-providers/models', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    const parsed = modelRequest.safeParse(request.body);
    if (!parsed.success || !parsed.data.ref) return reply.code(400).send({ error: '插件模型查询参数无效' });
    const { ref, model, accountRef, refresh } = parsed.data;
    const snapshot = await input.inventory.snapshot();
    const instance = snapshot.instances.find(
      (item) => item.pluginId === ref.pluginId && item.lifecycleState === 'installed',
    );
    const record = snapshot.packages.find((item) => item.packageDigest === instance?.packageDigest);
    if (
      !instance ||
      instance.activationState !== 'enabled' ||
      instance.configReadiness !== 'ready' ||
      !record?.manifest ||
      !input.registry.has(ref)
    )
      return reply.code(409).send({ error: '插件未启用或客户端尚未注册，请先修复插件配置' });
    const root = (input.projectRoot ?? resolveActiveProjectRoot)();
    if (parsed.data.customStartup)
      return { status: 'configured', models: [], message: 'custom_startup', contextDelivery: 'prompt_compatibility' };
    if (accountRef) {
      const account = resolveByAccountRef(root, accountRef);
      return {
        status: account ? 'configured' : 'unavailable',
        models: (account?.models ?? []).map((value) => ({ value, label: value })),
        message: account ? 'account_catalog' : 'account_unavailable',
        contextDelivery: 'prompt_compatibility',
      };
    }
    let located: Awaited<ReturnType<VerifiedPluginPackageLocator['resolveInstalledPackage']>> | undefined;
    try {
      located = await input.packages.resolveInstalledPackage(record.packageDigest);
      if (!isDeepStrictEqual(located.manifest, record.manifest)) throw new Error('ACP 插件包权威不一致');
      await located.verifyIntegrity();
      const raw = await readDeclaration(
        await resolvePackageFile(located.rootDir, AGENT_PROVIDER_DECLARATION_FILE, 'Agent provider declaration'),
      );
      await located.verifyIntegrity();
      const declared = parseAgentProviderDeclaration(raw, { packageRoot: located.rootDir });
      if (!declared.ok) throw new Error(declared.reason);
      const profiles = await resolveAgentClientLibrary({
        declaration: declared.declaration,
        admission: { instance, packageRecord: { ...record, manifest: record.manifest } },
        packageRoot: located.rootDir,
        configuration: input.configuration,
      });
      const profile = profiles.find((item) => item.id === ref.contributionId);
      if (!profile) return reply.code(409).send({ error: '插件客户端不存在，请重新读取工具列表' });
      const target = {
        kind: 'acp' as const,
        command: profile.acp.command,
        args: profile.acp.startupArgs,
        cwd: root,
        ...(model ? { model } : {}),
      };
      const key = JSON.stringify([
        access.operator,
        record.packageDigest,
        instance.pluginInstanceId,
        instance.lifecycleRevision,
        profile.acp,
        target,
      ]);
      const result = await cached(key, target, refresh);
      return { ...result, contextDelivery: 'prompt_compatibility' as const };
    } catch {
      return reply.code(409).send({ error: '插件程序包或连接配置不可用，请修正后重新读取模型' });
    } finally {
      await located?.release();
    }
  });
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
      const pluginName = record.manifest.name;
      let located: Awaited<ReturnType<VerifiedPluginPackageLocator['resolveInstalledPackage']>> | undefined;
      let configurationKey: string | null = null;
      let defaultClient: (AgentProviderDeclaration['acp'] & { id: string; name: string }) | undefined;
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
        configurationKey = parsed.declaration.configurationKey ?? null;
        if ('id' in parsed.declaration)
          defaultClient = { id: parsed.declaration.id, name: pluginName, ...parsed.declaration.acp };
        const profiles = await resolveAgentClientLibrary({
          declaration: parsed.declaration,
          admission: {
            instance,
            packageRecord: { ...record, manifest: record.manifest },
          },
          packageRoot: located.rootDir,
          configuration: input.configuration,
        });
        libraries.push({
          pluginId: instance.pluginId,
          presets: 'presets' in parsed.declaration ? (parsed.declaration.presets ?? []) : [],
          ...(defaultClient ? { configurationMode: 'single' as const, defaultClient } : {}),
          configurationKey,
          clients: profiles.map((profile) => ({
            id: profile.id,
            name: profile.name ?? (defaultClient ? pluginName : profile.id),
            ref: `plugin:${instance.pluginId}/${profile.id}`,
            available: input.registry.has({ pluginId: instance.pluginId, contributionId: profile.id }),
          })),
        });
      } catch (error) {
        libraries.push({
          pluginId: instance.pluginId,
          configurationKey,
          ...(defaultClient ? { configurationMode: 'single' as const, defaultClient } : {}),
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
