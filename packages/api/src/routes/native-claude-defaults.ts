import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import type { CatalogModel } from './runtime-model-catalog.js';

/** A settings snapshot is local configuration, never proof of a live session's adopted value. */
export function claudeConfiguredDefaults(
  settings: Settings,
  models: CatalogModel[],
  requestedModel?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const defaultModel = env.ANTHROPIC_MODEL ?? settings.env?.ANTHROPIC_MODEL ?? settings.model;
  const envEffort = env.CLAUDE_CODE_EFFORT_LEVEL ?? settings.env?.CLAUDE_CODE_EFFORT_LEVEL;
  const modelId = (value: string | undefined) => {
    if (!value) return undefined;
    const id = value.replace(/\[1m\]$/i, '');
    return models.find((model) => model.value === id)?.resolvedModel ?? id;
  };
  const defaultId = modelId(defaultModel);
  const selectedModel = requestedModel || defaultModel;
  const selectedId = modelId(selectedModel);
  const defaultEffort =
    envEffort ?? (defaultId ? settings.modelSettings?.[defaultId]?.effortLevel : undefined) ?? settings.effortLevel;
  const selectedEffort =
    envEffort ?? (selectedId ? settings.modelSettings?.[selectedId]?.effortLevel : undefined) ?? settings.effortLevel;
  return {
    defaultModel,
    defaultModelLabel:
      models.find((model) => model.value === defaultModel || model.resolvedModel === defaultId)?.label ?? defaultModel,
    defaultEffort,
    defaultModelSource: 'tool_config' as const,
    defaultEffortSource: 'tool_config' as const,
    selectedModel,
    selectedEffort,
    selectedEffortSource: 'tool_config' as const,
  };
}
