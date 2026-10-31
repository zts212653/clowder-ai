import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { AgyProfileConfig, NativeSessionBinding } from '@cat-cafe/shared';
import type { AgentServiceOptions } from '../../../../types.js';
import { preflightAgyNativeWorkspace } from '../../agy-native/agy-native-policy.js';
import { compileL0ViaSubprocess } from '../../l0-compiler.js';
import type { AcpInitializeResult, AcpNewSessionResult } from '../types.js';

export async function selectAgyAcpModel(
  client: { setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> },
  session: AcpNewSessionResult,
  sessionId: string,
  model: string,
): Promise<void> {
  const option = session.configOptions?.find((entry) => entry.id === 'model' || entry.category === 'model');
  if (option?.currentValue === model || session.models?.currentModelId === model) return;
  if (!option || !option.options?.some((entry) => entry.value === model))
    throw new Error('AGY ACP configured model is unavailable; refusing a different agent default');
  await client.setSessionConfigOption(sessionId, option.id, model);
}

export interface AgyAcpConfig {
  readonly profile: AgyProfileConfig;
  readonly profileHome: string;
  readonly l0CompilerFn?: typeof compileL0ViaSubprocess;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Provider-specific session inputs; SessionChain remains the sole durable binding owner. */
export async function prepareAgyAcpSession(input: {
  config: AgyAcpConfig;
  catId: string;
  model: string;
  cwd: string;
  capabilities?: AcpInitializeResult['agentCapabilities'];
  options?: AgentServiceOptions;
}) {
  const { profile, profileHome, l0CompilerFn = compileL0ViaSubprocess } = input.config;
  const options = input.options;
  const meta = record(input.capabilities?._meta?.antigravity);
  if (record(meta?.systemPrompt)?.append !== true)
    throw new Error('AGY ACP requires advertised native systemPrompt.append (1.4 or newer)');
  if (!profile.enabled || profile.carrier !== 'acp' || profile.model !== input.model)
    throw new Error('AGY ACP requires an enabled matching personal subscription profile');
  if (options?.cliConfigArgs?.length || Object.keys(options?.accountEnv ?? {}).length)
    throw new Error('AGY ACP refuses CLI/account environment overrides');
  const workspaceRoot = realpathSync(input.cwd);
  const home = realpathSync(profileHome);
  if (contains(home, workspaceRoot) || contains(workspaceRoot, home))
    throw new Error('AGY ACP profile overlaps its model-readable workspace');
  const preflight = preflightAgyNativeWorkspace(workspaceRoot);
  if (!preflight.ok) throw new Error(`AGY ACP workspace customization refused: ${preflight.path}`);
  const readOnly = options?.toolExecutionPolicy?.mode === 'read_only';
  if (options?.toolExecutionPolicy && !readOnly) throw new Error('AGY ACP cannot enforce this tool execution policy');
  if (!profile.autoApprove && !profile.trustedWorkspaces?.some((path) => realpathSync(path) === workspaceRoot))
    throw new Error('AGY ACP workspace requires operator admission');
  const body = await l0CompilerFn({
    catId: input.catId,
    userId: options?.callbackEnv?.CAT_CAFE_USER_ID ?? options?.auditContext?.userId,
    projection: 'owner',
  });
  if (!body.trim()) throw new Error('AGY ACP canonical L0 is empty');
  const binding: Omit<NativeSessionBinding, 'cliSessionId'> = {
    v: 1,
    carrier: 'agy_acp',
    l0Hash: createHash('sha256').update(body).digest('hex'),
    workspaceRoot,
    profileHome: home,
    model: input.model,
    permissionMode: profile.autoApprove && !readOnly ? 'always-proceed' : 'request-review',
    agentName: `cat-cafe-${input.catId}`,
  };
  const previous = options?.nativeSessionBinding;
  if (
    options?.sessionId &&
    (!previous ||
      previous.cliSessionId !== options.sessionId ||
      Object.entries(binding).some(([key, value]) => previous[key as keyof NativeSessionBinding] !== value))
  ) {
    throw new Error(
      'AGY ACP session binding differs or belongs to another carrier; start a new session explicitly (history is retained)',
    );
  }
  return {
    body,
    binding,
    readOnly,
    meta: { antigravity: { systemPrompt: { append: body }, ...(readOnly ? { enabledTools: [] } : {}) } },
    resume: input.capabilities?.sessionCapabilities?.resume !== undefined,
  };
}
