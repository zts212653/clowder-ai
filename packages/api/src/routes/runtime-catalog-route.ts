import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { catRegistry, isDshLauncher } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveByAccountRef } from '../config/account-resolver.js';
import { getRegisteredAcpConfig } from '../config/cat-config-loader.js';
import { resolveMemberEnvironment } from '../config/member-environment.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';
import { dshLauncherProfileState, dshProfileState } from './native-dsh-profile.js';
import { discoverNativeRuntimes } from './native-runtimes.js';
import { type CatalogTarget, probeRuntimeCatalog } from './runtime-catalog-probe.js';
import type { RuntimeModelCatalog } from './runtime-model-catalog.js';

const inputSchema = z
  .object({
    runtimeId: z.string().max(160),
    catId: z.string().max(160).optional(),
    accountRef: z.string().max(160).optional(),
    model: z.string().max(512).optional(),
    customStartup: z.boolean().optional(),
    refresh: z.boolean().optional(),
  })
  .strict();
const ttl = 5 * 60_000;
export function createCatalogCache(probe: typeof probeRuntimeCatalog = probeRuntimeCatalog, now = Date.now) {
  const values = new Map<string, { at: number; value: RuntimeModelCatalog }>();
  const inflight = new Map<string, Promise<RuntimeModelCatalog>>();
  return async (key: string, target: CatalogTarget, refresh = false): Promise<RuntimeModelCatalog> => {
    const previous = values.get(key);
    if (!refresh && previous && now() - previous.at < ttl) return previous.value;
    const running = inflight.get(key);
    if (running) return running;
    if (inflight.size >= 3) return { status: 'unavailable', models: [], message: 'busy' };
    const promise = probe(target)
      .then((value) => {
        if (value.status === 'live') {
          if (values.size >= 64) values.delete(values.keys().next().value!);
          values.set(key, { at: now(), value });
        } else values.delete(key);
        return value;
      })
      .catch(() => {
        values.delete(key);
        return previous
          ? {
              ...previous.value,
              status: 'configured' as const,
              message: 'refresh_failed',
              ...(previous.value.defaultModelStatus === undefined
                ? {}
                : {
                    defaultModel: undefined,
                    defaultModelLabel: undefined,
                    selectedModel: undefined,
                    selectedEffort: undefined,
                    selectedEffortLabel: undefined,
                    defaultEffort: undefined,
                    defaultEffortLabel: undefined,
                    defaultModelStatus: 'unreported' as const,
                  }),
            }
          : { status: 'unavailable' as const, models: [], message: 'discovery_failed' };
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
}
function modified(path: string) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
export function registerRuntimeCatalogRoute(app: FastifyInstance) {
  const cached = createCatalogCache();
  app.post('/api/cats/runtime-models', async (request, reply) => {
    if (!resolveHeaderUserId(request)) return reply.code(401).send({ error: '需要登录后读取工具模型' });
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '模型查询参数无效' });
    const data = parsed.data,
      root = resolveActiveProjectRoot();
    const runtime = (await discoverNativeRuntimes(root)).runtimes.find((item) => item.id === data.runtimeId);
    if (!runtime) return reply.code(404).send({ error: '运行工具不存在，请重新探测' });
    const fallback: RuntimeModelCatalog = {
      status: 'configured',
      models:
        'modelCatalog' in runtime && runtime.modelCatalog.length
          ? runtime.modelCatalog
          : runtime.models.map((value) => ({ value, label: value })),
    };
    if (data.accountRef) {
      const account = resolveByAccountRef(root, data.accountRef);
      if (!account) return { status: 'unavailable', models: [], message: 'account_unavailable' };
      return {
        ...fallback,
        models: (account?.models ?? []).map((value) => ({ value, label: value })),
        message: 'account_catalog',
      };
    }
    const member = catRegistry.tryGet(data.catId ?? (runtime.id.startsWith('acp:') ? runtime.id.slice(4) : ''))?.config;
    // Desktop needs explicit route preparation before ACP may initialize; catalog reads never select a provider.
    if ('dshDesktop' in runtime && runtime.dshDesktop) return { ...fallback, message: 'configured_only' };
    if (data.customStartup || member?.cliConfigArgs?.length) return { ...fallback, message: 'custom_startup' };
    // Native streams cannot use ACP discovery. AGY ACP also needs its isolated
    // profile launch contract, so this read path only returns configured models.
    if ('agyCarrier' in runtime || runtime.id === 'kimi' || runtime.id === 'opencode') {
      const selectedModel = data.model || ('configuredModel' in runtime ? runtime.configuredModel : undefined);
      const selected =
        'modelCatalog' in runtime ? runtime.modelCatalog.find((model) => model.value === selectedModel) : undefined;
      return {
        ...fallback,
        defaultModel: 'configuredModel' in runtime ? runtime.configuredModel : undefined,
        defaultEffort: 'configuredEffort' in runtime ? runtime.configuredEffort : undefined,
        defaultModelSource: 'tool_config',
        defaultEffortSource: 'tool_config',
        ...('configuredThinkingEnabled' in runtime ? { thinkingEnabled: runtime.configuredThinkingEnabled } : {}),
        ...('modelCatalog' in runtime
          ? {
              selectedModel,
              selectedEffort: selected?.defaultEffort,
              selectedEffortSource: 'tool_config' as const,
              effortOptions: selected?.efforts,
            }
          : {}),
        message: 'configured_only',
      };
    }
    // Arbitrary draft commands are never executable via this read-side API.
    if (member?.cli?.command && !['codex', 'claude'].includes(member.cli.command) && !runtime.id.startsWith('acp:'))
      return { ...fallback, message: 'custom_startup' };
    if (!runtime.installed) return { ...fallback, status: 'unavailable', message: 'not_installed' };
    const acp = runtime.id.startsWith('acp:')
      ? getRegisteredAcpConfig(runtime.id.slice(4), root)
      : 'acp' in runtime
        ? runtime.acp
        : undefined;
    if (acp?.transport === 'httpstream') return { ...fallback, message: 'unsupported_transport' };
    const env = member ? resolveMemberEnvironment(member.env) : undefined;
    const privateDsh =
      acp &&
      env?.DSH_HOME &&
      isDshLauncher(acp.command, acp.startupArgs) &&
      acp.startupArgs[0] === '--profile' &&
      acp.startupArgs[1] === 'acp';
    const dshState = privateDsh
      ? dshProfileState(env.DSH_HOME)
      : runtime.id === 'dsh' && 'discoveryStatus' in runtime
        ? runtime.discoveryStatus
        : acp
          ? dshLauncherProfileState(acp.command, acp.startupArgs, root)
          : undefined;
    if (dshState && dshState !== 'configured')
      return {
        ...fallback,
        status: dshState === 'acp_profile_invalid' ? 'unavailable' : 'configured',
        message: dshState,
      };
    if (!runtime.command) return { ...fallback, status: 'unavailable', message: 'not_installed' };
    const target: CatalogTarget = {
      kind: runtime.id === 'codex' ? 'codex' : runtime.id === 'claude' ? 'claude' : 'acp',
      command: runtime.command,
      args: acp?.startupArgs ?? [],
      cwd: root,
      ...(env ? { env } : {}),
      ...(data.model ? { model: data.model } : {}),
    };
    const home = homedir(),
      codex = process.env.CODEX_HOME || join(home, '.codex'),
      claude = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    const key = JSON.stringify([
      target,
      codex,
      claude,
      process.env.DSH_HOME,
      modified(join(codex, 'config.toml')),
      modified(join(codex, 'auth.json')),
      modified(join(claude, 'settings.json')),
      modified(join(root, '.claude/settings.json')),
      modified(join(root, '.claude/settings.local.json')),
    ]);
    const result = await cached(key, target, data.refresh);
    return {
      ...fallback,
      ...('configuredModel' in runtime
        ? {
            defaultModel: runtime.configuredModel,
            defaultEffort: 'configuredEffort' in runtime ? runtime.configuredEffort : undefined,
            defaultModelSource: 'tool_config' as const,
            defaultEffortSource: 'tool_config' as const,
          }
        : {}),
      ...result,
      models: result.models.length ? result.models : fallback.models,
    };
  });
}
