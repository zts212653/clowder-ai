/**
 * Config Registry
 * 收集所有运行时配置的快照，供 /config 命令展示。
 *
 * 纯函数，每次调用实时读取 (不缓存)。
 * 安全：Redis URL 不暴露，只显示连接状态。
 */

import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';
import { getOwnerConfig } from './cat-config-loader.js';
import { DEFAULT_CLI_TIMEOUT_MS, readCliTimeoutMsFromEnv } from '../utils/cli-timeout.js';
import { getAllCatBudgets } from './cat-budgets.js';
import { getCatModel } from './cat-models.js';
import { getCodexApprovalPolicy, getCodexSandboxMode } from './codex-cli.js';
import type { CodexAuthMode, ConfigSnapshot, HindsightEngine } from './config-snapshot.js';
import { parseHindsightRuntimeConfig } from './hindsight-runtime-config.js';
import { parseBoolean, parseEnum, parseIntInRange } from './parse-utils.js';

export type { CodexAuthMode, ConfigSnapshot, HindsightEngine } from './config-snapshot.js';

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
  const owner = getOwnerConfig();

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
  const port = parseInt(env.API_SERVER_PORT ?? '3003', 10);
  const host = env.API_SERVER_HOST ?? '127.0.0.1';
  const redis: 'connected' | 'memory' = env.REDIS_URL ? 'connected' : 'memory';

  // Cats (with env override support) — prefer registry, fallback to CAT_CONFIGS
  const cats: ConfigSnapshot['cats'] = {};
  const allConfigs = catRegistry.getAllIds().length > 0 ? catRegistry.getAllConfigs() : CAT_CONFIGS;
  for (const [id, config] of Object.entries(allConfigs)) {
    cats[id] = {
      displayName: config.displayName,
      provider: config.provider,
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
  const hindsightRuntime = parseHindsightRuntimeConfig(env);

  return {
    owner: {
      name: owner.name,
      aliases: [...owner.aliases],
      mentionPatterns: [...owner.mentionPatterns],
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
    governance: {
      degradationEnabled: true,
      doneTimeoutMs: 5 * 60 * 1000,
      heartbeatIntervalMs: 30_000,
    },
    deliberate: { status: 'types_only' },
    hindsight: {
      enabled: parseBoolean(env.HINDSIGHT_ENABLED, true),
      baseUrl: env.HINDSIGHT_URL ?? 'http://localhost:18888',
      sharedBank: 'cat-cafe-shared',
      recallDefaults: hindsightRuntime.recallDefaults,
      retainPolicy: {
        narrativeFactRequired: true,
        minUsefulHorizonDays: 180,
      },
      reflect: hindsightRuntime.reflect,
      freshnessGuard: hindsightRuntime.freshnessGuard,
      engine: {
        reflect: parseEnum<HindsightEngine>(
          env.HINDSIGHT_ENGINE_REFLECT,
          ['codex_oauth', 'hindsight_native'],
          'codex_oauth',
        ),
        retainExtraction: parseEnum<HindsightEngine>(
          env.HINDSIGHT_ENGINE_RETAIN_EXTRACTION,
          ['codex_oauth', 'hindsight_native'],
          'codex_oauth',
        ),
        allowNativeFallback: parseBoolean(env.HINDSIGHT_ENGINE_ALLOW_NATIVE_FALLBACK, false),
      },
      service: {
        mode: 'storage_retrieval_only',
        requireHealthcheck: parseBoolean(env.HINDSIGHT_SERVICE_REQUIRE_HEALTHCHECK, true),
        writeTimeoutMs: parseIntInRange(env.HINDSIGHT_SERVICE_WRITE_TIMEOUT_MS, 8000, 1000, 30000),
        recallTimeoutMs: parseIntInRange(env.HINDSIGHT_SERVICE_RECALL_TIMEOUT_MS, 8000, 1000, 30000),
      },
    },
    codexExecution: {
      model: codexExecutionModel,
      authMode: codexExecutionAuthMode,
      passModelArg: codexExecutionPassModelArg,
    },
  };
}
