import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { AgyProfileConfig, NativeSessionBinding } from '@cat-cafe/shared';
import type { AgentServiceOptions } from '../../../../types.js';
import { preflightAgyNativeWorkspace } from '../../agy-native/agy-native-policy.js';
import {
  canResumeAgyWorkspaceScope,
  matchesCatAgyAgentName,
} from '../../agy-native/launch/agy-session-compatibility.js';
import { compileL0ViaSubprocess } from '../../l0-compiler.js';
import { AcpSessionBindingError } from '../active-session-cache.js';
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
  const agentName = `cat-cafe-${input.catId}`;
  const preflight = preflightAgyNativeWorkspace(workspaceRoot, { hostAgentName: agentName });
  if (!preflight.ok) throw new Error(`AGY ACP workspace customization refused: ${preflight.path}`);
  const readOnly = options?.toolExecutionPolicy?.mode === 'read_only';
  if (options?.toolExecutionPolicy && !readOnly) throw new Error('AGY ACP cannot enforce this tool execution policy');
  if (
    !profile.autoApprove &&
    !profile.trustedWorkspaces?.some((path) => {
      try {
        return realpathSync(path) === workspaceRoot;
      } catch {
        return false;
      }
    })
  ) {
    throw new Error('AGY ACP workspace requires operator admission');
  }
  const body = await l0CompilerFn({
    frozenInput: options?.frozenL0Input,
    requireFrozenInput: true,
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
    agentName,
  };
  const previous = options?.nativeSessionBinding;
  if (options?.sessionId) {
    const agentMatch = previous ? matchesCatAgyAgentName(previous.agentName, input.catId) : null;
    const compatible =
      previous?.v === 1 &&
      previous.carrier === 'agy_acp' &&
      previous.cliSessionId === options.sessionId &&
      previous.profileHome === home &&
      agentMatch?.matches === true &&
      !(agentMatch.bornReadOnly && !readOnly) &&
      canResumeAgyWorkspaceScope({
        priorWorkspaceRoot: previous.workspaceRoot,
        nextWorkspaceRoot: workspaceRoot,
        profileHome: home,
        autoApprove: profile.autoApprove === true,
        trustedWorkspaces: profile.trustedWorkspaces,
      });
    if (!compatible) {
      throw new AcpSessionBindingError(
        'AGY ACP session binding is missing, belongs to another carrier/member/profile, or crosses an unrelated workspace boundary; start a new session explicitly (history is retained)',
      );
    }
  }
  return {
    body,
    binding,
    readOnly,
    meta: { antigravity: { systemPrompt: { append: body }, ...(readOnly ? { enabledTools: [] } : {}) } },
    resume: input.capabilities?.sessionCapabilities?.resume !== undefined,
  };
}
