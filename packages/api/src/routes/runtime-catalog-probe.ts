import type { SDKUserMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { discoverModelCatalog } from '@clowder-ai/agent-access/runtime/discover-model-catalog';
import type { AgentAccessClaudeCatalogSnapshot } from '@clowder-ai/agent-contract';
import { applySessionConfiguration } from '../domains/cats/services/agents/providers/acp/session-configuration.js';
import {
  captureClaudeSdkRuntime,
  claudeSdkRuntimeOptions,
} from '../domains/cats/services/agents/providers/claude-sdk-runtime.js';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { catalogRpc } from './runtime-catalog-rpc.js';
import { probeCodexCatalog } from './runtime-codex-discovery.js';
import { acpOption, type RuntimeModelCatalog, record } from './runtime-model-catalog.js';

export interface CatalogTarget {
  kind: 'codex' | 'claude' | 'acp';
  command: string;
  args: string[];
  cwd: string;
  model?: string;
  env?: Record<string, string>;
  generation?: string;
}

/** Fixture entry point for the native ACP parcel, without constructing a plugin inventory. */
export async function probeRuntimeCatalog(target: CatalogTarget): Promise<RuntimeModelCatalog> {
  if (target.kind === 'codex') return probeCodexCatalog(target.command, target.args, target.cwd);
  const probe = prepareAcpModelCatalogProbe(target);
  try {
    return await discoverModelCatalog({
      input: { operation: 'discover_model_catalog', client: target.kind, input: { model: target.model } },
      launch: async () => {
        throw new Error('catalog_unavailable');
      },
      readClaude: () => readClaudeModelCatalog(target),
      describeAcp: probe.describe,
      selectAcpModel: probe.select,
    });
  } finally {
    await probe.close();
  }
}

/** One disposable ACP session; only model/effort metadata leaves the Host. */
export function prepareAcpModelCatalogProbe(target: CatalogTarget) {
  let rpc: ReturnType<typeof catalogRpc> | undefined;
  let session: { sessionId: string; configOptions?: unknown } | undefined;
  const configuration = (value: unknown) => ({
    configOptions: [acpOption(value, 'model'), acpOption(value, 'thought_level')].filter(Boolean),
  });
  return {
    async describe() {
      if (rpc) throw new Error('catalog_request_not_approved');
      rpc = catalogRpc(target.command, target.args, target.cwd, undefined, target.env);
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'clowder-model-picker', version: '1.0.0' },
      });
      const result = record(await rpc.request('session/new', { cwd: target.cwd, mcpServers: [] }));
      if (typeof result.sessionId !== 'string') throw new Error('ACP 模型探测缺少会话标识');
      session = { ...configuration(result), sessionId: result.sessionId };
      return configuration(result);
    },
    async select(model: string) {
      const connection = rpc;
      if (!connection || !session || model !== target.model) throw new Error('catalog_request_not_approved');
      return configuration(
        await applySessionConfiguration(
          {
            setSessionConfigOption: (sessionId, configId, value) =>
              connection.request('session/set_config_option', { sessionId, configId, value }),
          },
          session,
          { model },
        ),
      );
    },
    async close() {
      await rpc?.close();
    },
  };
}

export async function readClaudeModelCatalog(target: CatalogTarget): Promise<AgentAccessClaudeCatalogSnapshot> {
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
        return session.supportedModels();
      })
      .catch(() => []);
    const settings = (await settingsRead)?.effective;
    return {
      models,
      env: {
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
        CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL,
      },
      ...(settings
        ? {
            settings: {
              ...(settings.model ? { model: settings.model } : {}),
              ...(settings.effortLevel ? { effortLevel: settings.effortLevel } : {}),
              env: {
                ANTHROPIC_MODEL: settings.env?.ANTHROPIC_MODEL,
                CLAUDE_CODE_EFFORT_LEVEL: settings.env?.CLAUDE_CODE_EFFORT_LEVEL,
              },
              modelSettings: Object.fromEntries(
                Object.entries(settings.modelSettings ?? {}).map(([id, value]) => [
                  id,
                  { effortLevel: value.effortLevel },
                ]),
              ),
            },
          }
        : {}),
    };
  } finally {
    clearTimeout(deadline);
    controller.abort();
    session?.close();
  }
}
