import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';
import { catalogRpc } from './runtime-catalog-rpc.js';
import {
  acpChoices,
  acpOption,
  parseAcpCatalog,
  parseClaudeModels,
  parseCodexModels,
  type RuntimeModelCatalog,
  record,
  text,
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
  const rpc = catalogRpc(
    target.command,
    target.kind === 'codex' ? [...target.args, 'app-server'] : target.args,
    target.cwd,
  );
  try {
    if (target.kind === 'codex') {
      await rpc.request('initialize', { clientInfo: { name: 'clowder-model-picker', version: '1.0.0' } });
      rpc.notify('initialized');
      const config = record(record(await rpc.request('config/read', { includeLayers: false, cwd: target.cwd })).config);
      const models: RuntimeModelCatalog['models'] = [];
      let cursor: string | undefined;
      do {
        const page = await rpc.request('model/list', { ...(cursor ? { cursor } : {}), limit: 100 });
        models.push(...parseCodexModels(page));
        cursor = text(record(page).nextCursor);
      } while (cursor && models.length < 1000);
      return {
        status: models.length ? 'live' : 'unavailable',
        models,
        defaultModel: text(config.model),
        defaultEffort: text(config.model_reasoning_effort),
      };
    }
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
  let session: ReturnType<typeof query> | undefined;
  try {
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
