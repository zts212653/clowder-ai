import { isAbsolute, resolve } from 'node:path';
import type { EffortLevel, Options } from '@anthropic-ai/claude-agent-sdk';
import type { CatId } from '@cat-cafe/shared';
import type { AgentServiceOptions, PreparedProviderRequestV1 } from '../../types.js';
import {
  ANTHROPIC_PROFILE_MODE_KEY,
  buildClaudeEnvOverrides,
  resolveClaudeEffortLevel,
  resolveClaudeModelSelection,
  SUBSCRIPTION_MODE_DENY_KEYS,
} from './ClaudeAgentService.js';
import { composeManagedSettingsDocument } from './claude-compaction-launch-plan.js';
import { resolveClaudeMcpConfig } from './claude-mcp-config.js';
import { appendLocalImagePathHints, collectImageAccessDirectories } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';
import { compileL0ViaSubprocess } from './l0-compiler.js';

function effortValue(effort: string): EffortLevel {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max')
    return effort;
  throw new Error(`claude_sdk_effort_unsupported:${effort}`);
}

/** Pass operator flags through the SDK's public extraArgs, reserving harness-owned settings. */
export function sdkOperatorArgs(args: readonly string[]): {
  extraArgs: Record<string, string | null>;
  settings?: string;
  additionalDirectories?: string[];
} {
  const extraArgs: Record<string, string | null> = {};
  const additionalDirectories: string[] = [];
  let settings: string | undefined;
  const reserved = new Set([
    'system-prompt',
    'system-prompt-file',
    'append-system-prompt',
    'append-system-prompt-file',
    'input-format',
    'output-format',
    'mcp-config',
    'strict-mcp-config',
    'tools',
    'permission-mode',
    'resume',
  ]);
  const parts = args
    .flatMap((arg) => {
      const trimmed = arg.trim();
      const tag = trimmed.match(/^(--[^\s=]+)\s+([\s\S]+)$/u);
      return tag ? [tag[1], tag[2]] : [trimmed];
    })
    .filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const arg = parts[i];
    if (!arg.startsWith('--')) throw new Error('claude_sdk_operator_args_invalid');
    const [name, ...suffix] = arg.slice(2).split('=');
    const value = suffix.length ? suffix.join('=') : parts[i + 1] && !parts[i + 1].startsWith('--') ? parts[++i] : null;
    if (name === 'settings') {
      if (!value) throw new Error('cli_config_args_settings_missing_value');
      settings = value;
    } else if (name === 'add-dir') {
      if (!value) throw new Error('cli_config_args_add_dir_missing_value');
      additionalDirectories.push(value);
    } else if (!reserved.has(name)) extraArgs[name] = value;
  }
  return {
    extraArgs,
    ...(settings === undefined ? {} : { settings }),
    ...(additionalDirectories.length ? { additionalDirectories } : {}),
  };
}

export async function prepareClaudeSdkLaunch(input: {
  catId: CatId;
  model: string;
  prompt: string;
  mcpServerPath?: string;
  l0CompilerFn: typeof compileL0ViaSubprocess;
  abortController: AbortController;
  options?: AgentServiceOptions;
}): Promise<{ prompt: string; model: string; sdkOptions: Options }> {
  const { options, catId } = input;
  if (options?.signal?.aborted) throw options.signal.reason ?? new Error('Invocation cancelled');
  // Alternate spawn transports cannot silently be ignored by this carrier.
  if (options?.spawnCliOverride) throw new Error('claude_sdk_spawn_override_unsupported');
  const readOnly = options?.toolExecutionPolicy?.mode === 'read_only';
  const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
  const prompt = appendLocalImagePathHints(input.prompt, imagePaths);
  const { effectiveModel, useEnvModelOverride } = resolveClaudeModelSelection(options?.callbackEnv, input.model);
  const effort = effortValue(resolveClaudeEffortLevel(catId, effectiveModel, options?.reasoningEffortOverride));
  const l0 = await input.l0CompilerFn({
    catId,
    userId: options?.callbackEnv?.CAT_CAFE_USER_ID ?? options?.auditContext?.userId,
  });
  const nativeInstructions = [
    { body: l0, injectionDecision: 'native_l0_compiled' },
    ...(options?.systemPrompt ? [{ body: options.systemPrompt, injectionDecision: 'route_append_system_prompt' }] : []),
  ];
  const mcpServers =
    !readOnly && options?.callbackEnv && input.mcpServerPath
      ? await resolveClaudeMcpConfig({
          callbackEnv: options.callbackEnv,
          workingDirectory: options.workingDirectory,
          mcpServerPath: input.mcpServerPath,
        })
      : {};
  const operator = sdkOperatorArgs(readOnly ? [] : (options?.cliConfigArgs ?? []));
  const additionalDirectories = [
    ...new Set([...(operator.additionalDirectories ?? []), ...collectImageAccessDirectories(imagePaths)]),
  ];
  const plan = options?.compactionLaunchPlan;
  const settings = plan?.ready
    ? composeManagedSettingsDocument(plan, operator.settings, options?.workingDirectory)
    : operator.settings;
  const env: Record<string, string | undefined> = { ...process.env };
  const overrides = { ...buildClaudeEnvOverrides(options?.callbackEnv), ...options?.accountEnv };
  if (options?.callbackEnv?.[ANTHROPIC_PROFILE_MODE_KEY] === 'subscription')
    for (const key of SUBSCRIPTION_MODE_DENY_KEYS) overrides[key] = null;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  if (readOnly) env.CAT_CAFE_READONLY = 'true';
  const request: PreparedProviderRequestV1 = Object.freeze({
    v: 1,
    message: Object.freeze({ body: prompt }),
    nativeInstructions: Object.freeze(nativeInstructions.map((entry) => Object.freeze(entry))),
    runtime: Object.freeze({
      provider: 'anthropic',
      carrier: 'agent_sdk',
      model: effectiveModel,
      protocol: 'sdk-streaming-input',
      reasoningEffort: effort,
      ...(readOnly ? { toolExecutionPolicy: 'read_only' as const } : {}),
    }),
    tools: Object.freeze({
      finalSurface: readOnly ? ('exact' as const) : ('declared_only' as const),
      declaredServerNames: Object.freeze(Object.keys(mcpServers).sort()),
      ...(readOnly ? { catCafeSchemas: Object.freeze([]) } : {}),
    }),
    providerNativeVisibility: 'unknown',
  });
  await options?.beforeProviderLaunch?.(request);
  return {
    prompt,
    model: effectiveModel,
    sdkOptions: {
      abortController: input.abortController,
      env,
      ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
      ...(!useEnvModelOverride && effectiveModel ? { model: effectiveModel } : {}),
      effort,
      systemPrompt: nativeInstructions.map((entry) => entry.body).join('\n\n'),
      includePartialMessages: true,
      permissionMode: readOnly ? 'plan' : 'bypassPermissions',
      ...(readOnly ? { tools: [] } : { allowDangerouslySkipPermissions: true }),
      strictMcpConfig: true,
      mcpServers: mcpServers as Options['mcpServers'],
      settingSources: readOnly
        ? []
        : options?.callbackEnv?.[ANTHROPIC_PROFILE_MODE_KEY] === 'api_key'
          ? ['project', 'local']
          : ['user', 'project', 'local'],
      ...(options?.sessionId ? { resume: options.sessionId } : {}),
      ...(additionalDirectories.length ? { additionalDirectories } : {}),
      ...(settings
        ? {
            settings: isAbsolute(settings)
              ? settings
              : settings.startsWith('{')
                ? settings
                : resolve(options?.workingDirectory ?? process.cwd(), settings),
          }
        : {}),
      extraArgs: { ...operator.extraArgs, ...(readOnly ? {} : { chrome: null }) },
    },
  };
}
