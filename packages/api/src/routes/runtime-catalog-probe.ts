import type { SDKUserMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';
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
}
export async function probeRuntimeCatalog(target: CatalogTarget): Promise<RuntimeModelCatalog> {
  if (target.kind === 'claude') return probeClaude(target);
  if (target.kind === 'codex') return probeCodexCatalog(target.command, target.args, target.cwd);
  const rpc = catalogRpc(target.command, target.args, target.cwd);
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
          selectedModel: target.model,
          effortOptions: undefined,
          message: 'custom_model',
        };
      }
      if (descriptor && target.model !== descriptor.currentValue) {
        // Query dependent options only in this disposable discovery session.
        selected = await rpc.request('session/set_config_option', {
          sessionId: session.sessionId,
          configId: descriptor.id,
          value: target.model,
        });
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
  const plan = process.platform === 'win32' ? resolveWindowsSpawnPlan(target.command, []) : undefined;
  const executable = plan?.mode === 'shim' ? (plan.args[0] ?? plan.command) : target.command;
  async function* noPrompts(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  let session: ReturnType<typeof sdkQuery> | undefined;
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    if (controller.signal.aborted) throw new Error('Model discovery cancelled before SDK query startup');
    session = query({
      prompt: noPrompts(),
      options: {
        cwd: target.cwd,
        env: buildChildEnv(undefined, { workingDirectory: target.cwd }),
        pathToClaudeCodeExecutable: executable,
        abortController: controller,
        settingSources: ['user', 'project', 'local'],
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        permissionMode: 'plan',
      },
    });
    const models = parseClaudeModels(await session.supportedModels());
    return { status: models.length ? 'live' : 'unavailable', models };
  } finally {
    clearTimeout(deadline);
    controller.abort();
    session?.close();
  }
}
