import type { SDKUserMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { applySessionConfiguration } from '../domains/cats/services/agents/providers/acp/session-configuration.js';
import {
  captureClaudeSdkRuntime,
  claudeSdkRuntimeOptions,
} from '../domains/cats/services/agents/providers/claude-sdk-runtime.js';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { claudeConfiguredDefaults } from './native-claude-defaults.js';
import { catalogRpc } from './runtime-catalog-rpc.js';
import { probeCodexCatalog } from './runtime-codex-discovery.js';
import {
  acpChoices,
  acpOption,
  parseAcpCatalog,
  parseClaudeModels,
  type RuntimeModelCatalog,
  record,
} from './runtime-model-catalog.js';

export interface CatalogTarget {
  kind: 'codex' | 'claude' | 'acp';
  command: string;
  args: string[];
  cwd: string;
  model?: string;
  env?: Record<string, string>;
}
export async function probeRuntimeCatalog(target: CatalogTarget): Promise<RuntimeModelCatalog> {
  if (target.kind === 'claude') return probeClaude(target);
  if (target.kind === 'codex') return probeCodexCatalog(target.command, target.args, target.cwd);
  const rpc = catalogRpc(target.command, target.args, target.cwd, undefined, target.env);
  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'clowder-model-picker', version: '1.0.0' },
    });
    const session = record(await rpc.request('session/new', { cwd: target.cwd, mcpServers: [] }));
    let selected: unknown = session;
    if (target.model) {
      const descriptor = acpOption(session, 'model');
      if (!descriptor || !acpChoices(descriptor.options).some((item) => item.value === target.model)) {
        // Keep custom / legacy aliases without applying an unadvertised value to the probe session.
        return {
          ...parseAcpCatalog(session, session),
          effortOptions: undefined,
          message: 'custom_model',
        };
      }
      if (descriptor && target.model !== descriptor.currentValue) {
        // Query dependent options only in this disposable discovery session.
        if (typeof session.sessionId !== 'string') throw new Error('ACP 模型探测缺少会话标识');
        selected = await applySessionConfiguration(
          {
            setSessionConfigOption: (sessionId, configId, value) =>
              rpc.request('session/set_config_option', { sessionId, configId, value }),
          },
          { sessionId: session.sessionId, configOptions: session.configOptions },
          { model: target.model },
        );
      }
    }
    return parseAcpCatalog(selected, session, target.model);
  } finally {
    await rpc.close();
  }
}

async function probeClaude(target: CatalogTarget): Promise<RuntimeModelCatalog> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 20_000);
  async function* noPrompts(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  let session: ReturnType<typeof sdkQuery> | undefined;
  try {
    const { query, resolveSettings } = await import('@anthropic-ai/claude-agent-sdk');
    // Local settings and model discovery are independent reads under one deadline.
    // Neither read may discard the successful part of the other.
    const settingsRead = controller.signal.aborted
      ? undefined
      : Promise.race([
          resolveSettings({ cwd: target.cwd, settingSources: ['user', 'project', 'local'] }).catch(() => undefined),
          new Promise<undefined>((resolve) =>
            controller.signal.addEventListener('abort', () => resolve(undefined), { once: true }),
          ),
        ]);
    const models = await captureClaudeSdkRuntime(target.command, controller.signal)
      .then(async (runtime) => {
        if (controller.signal.aborted) throw new Error('Model discovery cancelled before SDK query startup');
        session = query({
          prompt: noPrompts(),
          options: {
            cwd: target.cwd,
            ...(await claudeSdkRuntimeOptions(
              runtime,
              buildChildEnv(undefined, { workingDirectory: target.cwd }),
              controller.signal,
            )),
            abortController: controller,
            settingSources: ['user', 'project', 'local'],
            tools: [],
            mcpServers: {},
            strictMcpConfig: true,
            persistSession: false,
            permissionMode: 'plan',
          },
        });
        return parseClaudeModels(await session.supportedModels());
      })
      .catch(() => []);
    const settings = await settingsRead;
    return {
      status: models.length ? 'live' : 'unavailable',
      models,
      ...(!models.length ? { message: 'discovery_failed' } : {}),
      ...(settings ? claudeConfiguredDefaults(settings.effective, models, target.model) : {}),
    };
  } finally {
    clearTimeout(deadline);
    controller.abort();
    session?.close();
  }
}
