import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AgyProfileConfig, CatId } from '@cat-cafe/shared';
import { resolveCliCommand } from '../../../../../../utils/cli-resolve.js';
import type { CliSpawnOptions } from '../../../../../../utils/cli-types.js';
import { findMonorepoRoot } from '../../../../../../utils/monorepo-root.js';
import type { AgentServiceOptions, PreparedProviderRequestV1 } from '../../../types.js';
import { preflightAgyProfile, resolveAgyProfile, resolveAgySpawnCwd } from '../agy-profile-manager.js';
import { encodeAgyStreamJsonUserMessage } from '../agy-stream-json-parser.js';
import { materializeAgyNativeAgentFile } from './agy-native-agent-file.js';
import { prepareAgyNativeCredentialFile } from './agy-native-credential-file.js';
import { materializeAgyNativeMcpConfig } from './agy-native-mcp-config.js';
import { buildAgyNativePolicy, callbackPolicyForAgyNativeMcpTools } from './agy-native-policy.js';
import { materializeAgyNativeSettings } from './agy-native-settings.js';

export interface AgyNativeSessionBinding {
  readonly body: string;
  readonly l0Hash: string;
  readonly workspaceRoot: string;
}

export interface AgyNativeLaunchInput {
  readonly catId: CatId;
  readonly model: string;
  readonly profileConfig: AgyProfileConfig;
  readonly workspace: string;
  readonly prompt: string;
  readonly body: string;
  readonly prior?: AgyNativeSessionBinding;
  readonly command?: string;
  readonly options?: AgentServiceOptions;
}

export interface AgyNativeLaunchPlan {
  readonly cliOptions: CliSpawnOptions & { readonly cwd: string };
  readonly preparedRequest: PreparedProviderRequestV1;
  readonly agentName: string;
  readonly grantedMcpTools: readonly string[];
  readonly binding: AgyNativeSessionBinding;
  readonly disposeCredentials?: () => void;
}

function assertNoUntrustedProfilePrograms(home: string): void {
  for (const executable of ['hooks.json', 'plugins', 'skills.json']) {
    if (existsSync(join(home, '.gemini', 'config', executable))) {
      throw new Error(`AGY native profile has unvalidated executable config: ${executable}`);
    }
  }
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isolatedOAuthEnv(home: string): Record<string, string | null> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    TERM: 'dumb',
    HOME: home,
    GEMINI_HOME: join(home, '.gemini'),
    XDG_CONFIG_HOME: join(home, '.config'),
    GEMINI_API_KEY: null,
    GOOGLE_API_KEY: null,
    GOOGLE_GENAI_USE_VERTEXAI: null,
    GOOGLE_APPLICATION_CREDENTIALS: null,
    GOOGLE_CLOUD_PROJECT: null,
    GOOGLE_CLOUD_LOCATION: null,
    CAT_CAFE_AGENT_KEY_SECRET: null,
    CAT_CAFE_AGENT_KEY_FILE: null,
    CAT_CAFE_AGENT_KEY_FILES: null,
    CAT_CAFE_READONLY_AGENT_KEY_UNION: null,
    CAT_CAFE_API_URL: null,
    CAT_CAFE_INVOCATION_ID: null,
    CAT_CAFE_CALLBACK_TOKEN: null,
    CAT_CAFE_CREDENTIAL_FILE: null,
    CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE: null,
    CAT_CAFE_DESKTOP_MODE: null,
    CAT_CAFE_MCP_PROFILE: null,
    CAT_CAFE_READONLY: null,
  };
}

function validatedTaskPolicy(input: AgyNativeLaunchInput): ReturnType<typeof buildAgyNativePolicy> {
  const scope = input.options?.agyNativeScope ?? { writableFiles: [], mcpTools: [] };
  const policy = buildAgyNativePolicy({
    workspaceRoot: input.workspace,
    writableFiles: input.options?.toolExecutionPolicy?.mode === 'read_only' ? [] : scope.writableFiles,
    mcpTools: scope.mcpTools,
  });
  if (
    scope.writableFiles.length > 0 &&
    (!scope.workspaceRoot || !scope.taskId || realpathSync(scope.workspaceRoot) !== policy.workspaceRoot)
  ) {
    throw new Error('AGY native write scope requires the exact Task workspace binding');
  }
  const callbackPolicy = callbackPolicyForAgyNativeMcpTools(policy.grantedMcpTools);
  if (
    input.options?.toolExecutionPolicy?.mode === 'callback_allowlist' &&
    JSON.stringify(input.options.toolExecutionPolicy.allowedCallbackRoutes) !==
      JSON.stringify(callbackPolicy.allowedCallbackRoutes)
  ) {
    throw new Error('AGY native MCP grant and server-side callback scope disagree');
  }
  if (policy.grantedMcpTools.length && input.options?.toolExecutionPolicy?.mode !== 'callback_allowlist') {
    throw new Error('AGY native MCP requires server-side callback scope');
  }
  const grantedRequiredNames = new Set(policy.grantedMcpTools.map((tool) => tool.replace('/', '::')));
  if (input.options?.requiredTools?.some((tool) => !grantedRequiredNames.has(tool))) {
    throw new Error('AGY native required MCP tool is outside the task scope');
  }
  return policy;
}

function assertOperatorTrustedWorkspace(config: AgyProfileConfig, workspaceRoot: string): void {
  const trusted = config.trustedWorkspaces?.some((path) => {
    if (!isAbsolute(path)) return false;
    try {
      return realpathSync(path) === workspaceRoot;
    } catch {
      return false;
    }
  });
  if (!trusted) throw new Error('AGY native workspace is outside the operator trusted workspace list');
}

function materializeTaskMcp(
  home: string,
  grantedMcpTools: readonly string[],
  callbackEnv?: Readonly<Record<string, string>>,
): (() => void) | undefined {
  const credential = grantedMcpTools.length ? prepareAgyNativeCredentialFile(home, callbackEnv ?? {}) : undefined;
  try {
    materializeAgyNativeMcpConfig({
      profileHome: home,
      runtimeRoot: findMonorepoRoot(process.cwd()),
      serverNames: grantedMcpTools.map((tool) => tool.slice(0, tool.indexOf('/'))),
      ...(credential ? { callback: { apiUrl: credential.apiUrl, credentialFile: credential.path } } : {}),
    });
    return credential?.dispose;
  } catch (error) {
    credential?.dispose();
    throw error;
  }
}

/** Prepare one short CLI process with the same exact MCP grant on both sides of callback auth. */
export function prepareAgyNativeLaunch(input: AgyNativeLaunchInput): AgyNativeLaunchPlan {
  const options = input.options;
  const policy = validatedTaskPolicy(input);
  assertOperatorTrustedWorkspace(input.profileConfig, policy.workspaceRoot);
  const profile = resolveAgyProfile({
    catId: input.catId,
    expectedModel: input.model,
    workingDirectory: policy.workspaceRoot,
    config: input.profileConfig,
  });
  if (!profile) throw new Error('AGY native isolated profile is disabled');
  const home = realpathSync(profile.homePath);
  if (containsPath(home, policy.workspaceRoot) || containsPath(policy.workspaceRoot, home)) {
    throw new Error('AGY native profile HOME overlaps the model-readable workspace');
  }
  assertNoUntrustedProfilePrograms(home);
  const agent = materializeAgyNativeAgentFile({ profileHome: home, catId: input.catId, systemPrompt: input.body });
  materializeAgyNativeSettings({ profileHome: home, model: input.model, policy });
  const command = input.command ?? resolveCliCommand('agy');
  if (!command) throw new Error('AGY native CLI binary was not found');
  const profilePreflight = preflightAgyProfile(profile, {
    agyCommand: command,
    workingDirectory: policy.workspaceRoot,
  });
  if (!profilePreflight.ok) throw new Error(profilePreflight.message);
  const resume = input.prior?.l0Hash === agent.l0Hash && input.prior.workspaceRoot === policy.workspaceRoot;
  const args = [
    '--add-dir',
    policy.workspaceRoot,
    ...policy.cliArgs,
    '--agent',
    agent.agentName,
    '--model',
    input.model,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    ...(resume && options?.sessionId ? ['--conversation', options.sessionId] : []),
  ];
  const preparedRequest: PreparedProviderRequestV1 = Object.freeze({
    v: 1,
    message: Object.freeze({ body: input.prompt }),
    nativeInstructions: Object.freeze([
      { body: readFileSync(agent.filePath, 'utf8'), injectionDecision: 'native_agent_file_compiled' },
    ]),
    runtime: Object.freeze({
      provider: 'google',
      carrier: 'antigravity_cli',
      model: input.model,
      protocol: 'stream-json',
    }),
    tools: Object.freeze({ finalSurface: 'unknown' as const }),
    providerNativeVisibility: 'unknown',
  });
  const cliOptions: CliSpawnOptions & { readonly cwd: string } = {
    command,
    args,
    cwd: resolveAgySpawnCwd(profile, input.catId, policy.workspaceRoot),
    env: isolatedOAuthEnv(home),
    inheritParentEnv: false,
    stdinInput: `${encodeAgyStreamJsonUserMessage(input.prompt)}\n`,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
    ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
    ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
  };
  const disposeCredentials = materializeTaskMcp(home, policy.grantedMcpTools, options?.callbackEnv);
  return {
    cliOptions,
    preparedRequest,
    agentName: agent.agentName,
    grantedMcpTools: policy.grantedMcpTools,
    binding: { body: input.body, l0Hash: agent.l0Hash, workspaceRoot: policy.workspaceRoot },
    ...(disposeCredentials ? { disposeCredentials } : {}),
  };
}
