import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import { validateRuntimeProviderBinding } from '../../config/account-resolver.js';
import { resolveCatRuntimeAccount } from '../../config/cat-runtime-account.js';
import { spawnCli } from '../../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../../utils/cli-spawn-win.js';
import { buildUnixSupervisedSpawnPlan } from '../../utils/cli-supervised-process.js';
import type { SpawnFn } from '../../utils/cli-types.js';
import { findMonorepoRoot } from '../../utils/monorepo-root.js';
import { ClaudeAgentService } from '../cats/services/agents/providers/ClaudeAgentService.js';
import { hasSupportedEnvTemplate } from '../cats/services/agents/providers/env-map.js';
import { compileL0ViaSubprocess } from '../cats/services/agents/providers/l0-compiler.js';
import { captureInvocationL0Input } from '../cats/services/agents/providers/l0-input-capture.js';
import { captureMemberExecutionPreferences } from '../cats/services/agents/providers/member-execution-preferences.js';
import { prepareQualificationLaunch } from './message-query-launch.js';
import { QUERY_QUALIFICATION_INSTRUCTIONS } from './message-query-protocol.js';
import type { QueryBatchRunner } from './message-query-qualifier.js';

/** Keep the existing supervisor, giving its descendant cleanup time to finish
 * before the outer stream controller can escalate. This read-only call owns no writes. */
const spawnQualificationCli: SpawnFn = (command, args, options) => {
  if (process.platform === 'win32') {
    const plan = resolveWindowsSpawnPlan(command, args);
    return spawn(plan.command, plan.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
      ...(plan.shell === undefined ? {} : { shell: plan.shell }),
    });
  }
  const plan = buildUnixSupervisedSpawnPlan(command, args, { env: options.env, killGraceMs: 50 });
  return spawn(plan.command, plan.args, { cwd: options.cwd, env: plan.env, stdio: options.stdio });
};

export const qualificationSpawnDeps = {
  spawnFn: spawnQualificationCli,
  terminationGraces: { interruptMs: 0, terminateMs: 1500 },
  exitDrainGraceMs: 75,
};

/** Existing native OAuth account and full L0; this consumer never starts a family turn or MCP server. */
export const runNativeQueryBatch: QueryBatchRunner = async (batch, context) => {
  const entered = performance.now();
  let usageAt: number | undefined;
  const trace = (event: Record<string, unknown>) => {
    const now = performance.now();
    if (event.phase === 'native-usage') usageAt = now;
    context.onTrace?.({ ...event, runnerElapsedMs: Math.max(0, now - entered) });
  };
  context.signal?.throwIfAborted();
  const config = catRegistry.tryGet('haiku55')?.config;
  if (!config || config.clientId !== 'anthropic' || config.defaultModel !== 'claude-haiku-5-5')
    throw new Error('Qualification provider unavailable');
  const root = process.env.CAT_TEMPLATE_PATH ? dirname(resolve(process.env.CAT_TEMPLATE_PATH)) : findMonorepoRoot();
  const account = resolveCatRuntimeAccount(root, config.id, 'anthropic', config);
  if (!account || account.id !== 'claude' || account.authType !== 'oauth')
    throw new Error('Qualification OAuth binding unavailable');
  const incompatibility = validateRuntimeProviderBinding('anthropic', account, config.defaultModel);
  if (incompatibility) throw new Error(incompatibility);
  const accountEnv = Object.fromEntries(
    Object.entries(account.envVars ?? {}).filter(
      ([key, value]) =>
        /^[A-Z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('CAT_CAFE_') && !hasSupportedEnvTemplate(value),
    ),
  );
  const controller = new AbortController();
  const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
  const observer = nativeQualificationObserver(config.defaultModel, controller, trace);
  let successful = false;
  let failed = false;
  let launched = false;
  let text = '';
  const service = new ClaudeAgentService({
    catId: config.id,
    model: config.defaultModel,
    rawArchive: observer.archive,
    l0CompilerFn: (options) => compileL0ViaSubprocess({ ...options, cwd: root }),
  });
  for await (const message of service.invoke(JSON.stringify(batch), {
    executionPreferences: captureMemberExecutionPreferences(config.id, config, config.defaultModel),
    frozenL0Input: captureInvocationL0Input({
      catId: config.id,
      catConfig: config,
      userId: context.userId,
      model: config.defaultModel,
      compilerCwd: root,
    }),
    workingDirectory: root,
    systemPrompt: QUERY_QUALIFICATION_INSTRUCTIONS,
    callbackEnv: {
      CAT_CAFE_USER_ID: context.userId,
      CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
      CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: config.defaultModel,
    },
    accountEnv,
    ...(account.claude ? { claudeTokenAccount: true } : {}),
    signal,
    invocationId: `message-query-${randomUUID()}`,
    reasoningEffortOverride: 'low',
    toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    spawnCliOverride: async function* (original) {
      signal.throwIfAborted();
      if (launched) throw new Error('Qualification retries are unavailable');
      launched = true;
      const prepared = prepareQualificationLaunch(original, config.defaultModel, trace);
      trace({
        phase: 'native-launch',
        model: config.defaultModel,
        rows: batch.rows.length,
        bodyChars: batch.rows.reduce((sum, row) => sum + row.body.length, 0),
        safeMode: true,
      });
      yield* spawnCli(prepared, qualificationSpawnDeps);
    },
  })) {
    if (message.type === 'text')
      text = message.textMode === 'replace' ? (message.content ?? '') : text + (message.content ?? '');
    if (text.length > 128_000) {
      controller.abort(new Error('Qualification output budget exceeded'));
      throw new Error('Qualification output budget exceeded');
    }
    if (message.type === 'error' && message.errorDisposition !== 'transient') failed = true;
    if (message.type === 'done') {
      successful = true;
      failed ||= Boolean(message.errorCode);
    }
  }
  signal.throwIfAborted();
  if (!observer.verified() || !successful || failed) throw new Error('Qualification native result unavailable');
  trace({
    phase: 'native-completed',
    outputChars: text.length,
    ...(usageAt === undefined ? {} : { afterUsageMs: Math.max(0, performance.now() - usageAt) }),
  });
  return text;
};

function nativeQualificationObserver(
  model: string,
  controller: AbortController,
  trace?: (value: Record<string, unknown>) => void,
) {
  let surface = false,
    response = false;
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const observe = (value: unknown) => {
    const item = object(value);
    if (item.type === 'system' && item.subtype === 'init') {
      surface =
        item.model === model &&
        Array.isArray(item.tools) &&
        item.tools.length === 0 &&
        Array.isArray(item.mcp_servers) &&
        item.mcp_servers.length === 0;
      trace?.({ phase: 'native-init', model: item.model, tools: item.tools, mcpServers: item.mcp_servers });
      if (!surface) controller.abort(new Error('Qualification native surface mismatch'));
      return;
    }
    if (item.type === 'result') {
      trace?.({
        phase: 'native-usage',
        usage: item.usage,
        modelUsage: item.modelUsage,
        costUsd: item.total_cost_usd,
        durationMs: item.duration_ms,
      });
      return;
    }
    if (item.type === 'assistant') {
      const message = object(item.message);
      const content = Array.isArray(message.content) ? message.content : [];
      trace?.({
        phase: 'native-output',
        usage: message.usage,
        outputChars: content.reduce((sum, block) => {
          const value = object(block);
          return sum + (value.type === 'text' && typeof value.text === 'string' ? value.text.length : 0);
        }, 0),
      });
      return;
    }
    if (item.type !== 'stream_event') return;
    const event = object(item.event);
    if (event.type !== 'message_start') return;
    const message = object(event.message);
    response = message.model === model;
    trace?.({ phase: 'native-response', model: message.model });
    if (!response) controller.abort(new Error('Qualification response model mismatch'));
  };
  return {
    archive: { append: async (_id: string, event: unknown) => observe(event) },
    verified: () => surface && response,
  };
}
