import {
  type AgentAccessClaudeCatalogSnapshot,
  type AgentAccessModelCatalog,
  agentAccessModelCatalogRequestSchema,
} from '@clowder-ai/agent-contract';
import { claudeConfiguredDefaults } from './claude-catalog-defaults.js';
import { discoverCodexModelCatalog } from './codex-model-catalog.js';
import { acpChoices, acpOption, parseAcpCatalog, parseClaudeModels } from './runtime-model-catalog.js';

type CodexLauncher = Parameters<typeof discoverCodexModelCatalog>[1];

export async function discoverModelCatalog({
  input,
  launch,
  readClaude,
  describeAcp,
  selectAcpModel,
}: {
  input: unknown;
  launch: CodexLauncher;
  readClaude: () => Promise<AgentAccessClaudeCatalogSnapshot>;
  describeAcp: () => Promise<unknown>;
  selectAcpModel: (model: string) => Promise<unknown>;
}): Promise<AgentAccessModelCatalog> {
  const request = agentAccessModelCatalogRequestSchema.parse(input);
  const { model } = request.input;
  if (request.client === 'codex') return discoverCodexModelCatalog(request.input, launch);
  if (request.client === 'claude') {
    const snapshot = await readClaude();
    const models = parseClaudeModels(snapshot.models);
    return {
      status: models.length ? 'live' : 'unavailable',
      models,
      ...(!models.length ? { message: 'discovery_failed' } : {}),
      ...(snapshot.settings ? claudeConfiguredDefaults(snapshot.settings, models, model, snapshot.env) : {}),
    };
  }

  const session = await describeAcp();
  let selected = session;
  if (model) {
    const descriptor = acpOption(session, 'model');
    if (!descriptor || !acpChoices(descriptor.options).some((item) => item.value === model)) {
      return { ...parseAcpCatalog(session, session), effortOptions: undefined, message: 'custom_model' };
    }
    if (model !== descriptor.currentValue) selected = await selectAcpModel(model);
  }
  return parseAcpCatalog(selected, session, model);
}
