/**
 * Config Registry
 * 收集所有运行时配置的快照，供 /config 命令展示。
 *
 * 纯函数，每次调用实时读取 (不缓存)。
 * 安全：Redis URL 不暴露，只显示连接状态。
 */

import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';
import { DEFAULT_CLI_TIMEOUT_MS, readCliTimeoutMsFromEnv } from '../utils/cli-timeout.js';
import { configStore } from './ConfigStore.js';
import { getAllCatBudgets } from './cat-budgets.js';
import { getCoCreatorConfig } from './cat-config-loader.js';
import { getCatModel } from './cat-models.js';
import { getCodexApprovalPolicy, getCodexSandboxMode } from './codex-cli.js';
import type { CodexAuthMode, ConfigSnapshot } from './config-snapshot.js';
import { parseBoolean, parseEnum } from './parse-utils.js';

export type { CodexAuthMode, ConfigSnapshot } from './config-snapshot.js';

function formatTtl(raw: string | undefined, defaultSeconds: number): string {
  if (!raw) {
    return `${Math.round(defaultSeconds / 86400)} days`;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return `${Math.round(defaultSeconds / 86400)} days`;
  }
  if (parsed <= 0) {
    return 'disabled (persistent)';
  }
  if (parsed % 86400 === 0) {
    return `${parsed / 86400} days`;
  }
  if (parsed % 3600 === 0) {
    return `${parsed / 3600} hours`;
  }
  return `${Math.trunc(parsed)} seconds`;
}

/**
 * Collect a snapshot of all runtime configuration values.
 * Sources: process.env + hardcoded defaults + CAT_CONFIGS.
 */
export function collectConfigSnapshot(): ConfigSnapshot {
  const env = process.env;

  // Context (from ContextAssembler defaults + env overrides)
  const maxMessages = Number(env.CONTEXT_HISTORY_LIMIT) || 20;
  const maxContentLength = Number(env.MAX_CONTEXT_MSG_CHARS) || 1500;
  const maxTotalChars = 8000;
  const maxPromptTokens = Number(env.MAX_PROMPT_TOKENS) || 32000;
  const coCreator = getCoCreatorConfig();

  // CLI (from cli-spawn.ts defaults, configurable via CLI_TIMEOUT_MS, 0 = disable)
  const timeoutMs = readCliTimeoutMsFromEnv(env) ?? DEFAULT_CLI_TIMEOUT_MS;
  const killGraceMs = 3_000;
  const codexSandboxMode = getCodexSandboxMode(env);
  const codexApprovalPolicy = getCodexApprovalPolicy(env);

  // Storage (from Redis/memory store defaults)
  const messageTTL = formatTtl(env.MESSAGE_TTL_SECONDS, 7 * 24 * 60 * 60);
  const threadTTL = formatTtl(env.THREAD_TTL_SECONDS, 30 * 24 * 60 * 60);
  const taskTTL = formatTtl(env.TASK_TTL_SECONDS, 30 * 24 * 60 * 60);
  const maxMessagesStore = 2000;
  const maxThreads = 100;

  // Upload (from messages route)
  const maxFileSize = '10 MB';
  const maxFiles = 5;

  // Server
  const port = parseInt(env.API_SERVER_PORT ?? '3004', 10);
  const host = env.API_SERVER_HOST ?? '127.0.0.1';
  const redis: 'connected' | 'memory' = env.REDIS_URL ? 'connected' : 'memory';

  // Cats (with env override support) — prefer registry, fallback to CAT_CONFIGS
  const cats: ConfigSnapshot['cats'] = {};
  const allConfigs = catRegistry.getAllIds().length > 0 ? catRegistry.getAllConfigs() : CAT_CONFIGS;
  for (const [id, config] of Object.entries(allConfigs)) {
    cats[id] = {
      displayName: config.displayName,
      clientId: config.clientId,
      model: getCatModel(id),
      mcpSupport: config.mcpSupport,
    };
  }

  // A2A
  const a2aMaxDepth = Number(env.MAX_A2A_DEPTH) || 15;
  const defaultCodexModel = getCatModel('codex');
  const codexExecutionModel = env.CAT_CODEX_EXEC_MODEL?.trim() || defaultCodexModel;
  const codexExecutionAuthMode = parseEnum<CodexAuthMode>(env.CODEX_AUTH_MODE, ['oauth', 'api_key', 'auto'], 'oauth');
  const codexExecutionPassModelArg = parseBoolean(env.CAT_CODEX_PASS_MODEL_ARG, true);

  // UI bubble display defaults (hot-updatable via ConfigStore)
  const bubbleThinking = (configStore.get('ui.bubble.thinking') ?? env.UI_BUBBLE_THINKING_DEFAULT ?? 'collapsed') as
    | 'expanded'
    | 'collapsed';
  const bubbleCli = (configStore.get('ui.bubble.cliOutput') ?? env.UI_BUBBLE_CLI_OUTPUT_DEFAULT ?? 'collapsed') as
    | 'expanded'
    | 'collapsed';

  return {
    coCreator: {
      name: coCreator.name,
      aliases: [...coCreator.aliases],
      mentionPatterns: [...coCreator.mentionPatterns],
      ...(coCreator.avatar ? { avatar: coCreator.avatar } : {}),
      ...(coCreator.color ? { color: coCreator.color } : {}),
    },
    context: {
      maxMessages,
      maxContentLength,
      maxTotalChars,
      maxPromptTokens,
      note: 'These are assembleContext defaults; see perCatBudgets for actual per-cat limits',
    },
    perCatBudgets: getAllCatBudgets(),
    cli: { timeoutMs, killGraceMs, codexSandboxMode, codexApprovalPolicy },
    storage: { messageTTL, threadTTL, taskTTL, maxMessages: maxMessagesStore, maxThreads },
    upload: { maxFileSize, maxFiles },
    server: { port, host, redis },
    cats,
    a2a: { enabled: true, maxDepth: a2aMaxDepth },
    memory: { enabled: true, maxKeysPerThread: 50 },
    f102: {
      embedMode: env.EMBED_MODE ?? 'off',
      abstractiveEnabled: env.F102_ABSTRACTIVE === 'on',
    },
    governance: {
      degradationEnabled: true,
      doneTimeoutMs: 5 * 60 * 1000,
      heartbeatIntervalMs: 30_000,
    },
    deliberate: { status: 'types_only' },
    codexExecution: {
      model: codexExecutionModel,
      authMode: codexExecutionAuthMode,
      passModelArg: codexExecutionPassModelArg,
    },
    ui: {
      bubbleDefaults: {
        thinking: bubbleThinking,
        cliOutput: bubbleCli,
      },
    },
  };
}
