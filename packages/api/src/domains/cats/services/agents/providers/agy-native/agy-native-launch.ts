import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AgyProfileConfig, CatId, NativeSessionBinding } from '@cat-cafe/shared';
import { resolveCliCommand } from '../../../../../../utils/cli-resolve.js';
import type { CliSpawnOptions } from '../../../../../../utils/cli-types.js';
import { findMonorepoRoot } from '../../../../../../utils/monorepo-root.js';
import type { AgentServiceOptions, PreparedProviderRequestV1 } from '../../../types.js';
import { preflightAgyProfile, resolveAgyProfile, resolveAgySpawnCwd } from '../agy-profile-manager.js';
import { encodeAgyStreamJsonUserMessage } from '../agy-stream-json-parser.js';
import { resolveProviderMcpConfig } from '../provider-mcp-config.js';
import { materializeAgyNativeAgentFile } from './agy-native-agent-file.js';
import { prepareAgyNativeCredentialFile } from './agy-native-credential-file.js';
import { materializeAgyNativeEffectGuard } from './agy-native-effect-guard.js';
import { AgyNativeResumeMismatchError } from './agy-native-errors.js';
import { prepareAgyNativeInput } from './agy-native-input.js';
import { prepareAgyNativeKeychain } from './agy-native-keychain.js';
import { executionOwnerEnv, isolatedOAuthEnv } from './agy-native-launch-env.js';
import { materializeAgyNativeMcpConfig, validateAgyNativeAccountMcp } from './agy-native-mcp-config.js';
import { type AgyNativePermissionMode, buildAgyNativePolicy } from './agy-native-policy.js';
import { waitForAgyNativeProfileTurn } from './agy-native-profile-turn.js';
import { createAgyNativeRunProfile } from './agy-native-run-profile.js';
import { materializeAgyNativeSettings } from './agy-native-settings.js';
import { materializeAgyNativeSkills, retireAgyNativeLegacySkillAlias } from './agy-native-skills.js';
import { AGY_NATIVE_MCP_TOOLS } from './agy-native-tools.js';
import { acquireAgyNativeProfileTurnAsync } from './profile-turn/async.js';

export interface AgyNativeLaunchInput {
  readonly catId: CatId;
  readonly model: string;
  readonly profileConfig: AgyProfileConfig;
  readonly workspace: string;
  readonly prompt: string;
  readonly body: string;
  readonly command?: string;
  readonly options?: AgentServiceOptions;
  readonly controlOperation?: 'compact';
}

export interface AgyNativeLaunchPlan {
  readonly cliOptions: CliSpawnOptions & { readonly cwd: string };
  readonly preparedRequest: PreparedProviderRequestV1;
  readonly agentName: string;
  readonly permissionMode: AgyNativePermissionMode;
  readonly agentTools: readonly string[];
  readonly binding: Omit<NativeSessionBinding, 'cliSessionId'>;
  readonly resumeSessionId?: string;
  readonly bindSession: (sessionId: string) => void | Promise<void>;
  readonly disposeCredentials?: () => void | Promise<void>;
}

function assertNoUntrustedProfilePrograms(home: string): void {
  for (const executable of ['plugins', 'skills.json']) {
    if (existsSync(join(home, '.gemini', 'config', executable))) {
      throw new Error(`AGY native profile has unvalidated executable config: ${executable}`);
    }
  }
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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

async function materializeTaskMcp(
  home: string,
  input: AgyNativeLaunchInput,
  callbackEnv?: Readonly<Record<string, string>>,
): Promise<(() => void) | undefined> {
  const ordinary = input.options?.toolExecutionPolicy?.mode !== 'read_only';
  const credential = ordinary && callbackEnv ? prepareAgyNativeCredentialFile(home, callbackEnv ?? {}) : undefined;
  try {
    const runtimeRoot = findMonorepoRoot(process.cwd());
    const resolvedServers =
      ordinary && credential
        ? await resolveProviderMcpConfig({
            callbackEnv: { ...callbackEnv, CAT_CAFE_CAT_ID: input.catId },
            workingDirectory: input.workspace,
            mcpServerPath: join(runtimeRoot, 'packages/mcp-server/dist/index.js'),
            credentialFile: credential.path,
            provider: 'google',
          })
        : undefined;
    materializeAgyNativeMcpConfig({
      profileHome: home,
      runtimeRoot,
      serverNames: resolvedServers ? Object.keys(resolvedServers) : [],
      ...(resolvedServers ? { resolvedServers } : {}),
      ...(credential ? { callback: { apiUrl: credential.apiUrl, credentialFile: credential.path } } : {}),
    });
    return credential?.dispose;
  } catch (error) {
    credential?.dispose();
    throw error;
  }
}

/** Prepare the ordinary native tool surface with canonical MCP identity and resume provenance. */
export async function prepareAgyNativeLaunch(input: AgyNativeLaunchInput): Promise<AgyNativeLaunchPlan> {
  const options = input.options;
  const policy = buildAgyNativePolicy({
    workspaceRoot: input.workspace,
    autoApprove: input.profileConfig.autoApprove,
    readOnly: options?.toolExecutionPolicy?.mode === 'read_only',
  });
  // A per-turn restriction narrows tools; it does not revoke the operator's workspace admission.
  if (input.profileConfig.autoApprove !== true)
    assertOperatorTrustedWorkspace(input.profileConfig, policy.workspaceRoot);
  const profile = resolveAgyProfile({
    materializeSettings: false,
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
  const ownerInvocationId = options?.auditContext?.invocationId ?? options?.invocationId;
  const releaseProfile = await waitForAgyNativeProfileTurn(home, ownerInvocationId, options?.signal, {
    preparation: true,
  });
  let disposeCredentials: (() => void) | undefined;
  let releaseSession: (() => Promise<void>) | undefined;
  let releaseStartup: (() => Promise<void>) | undefined;
  let runProfile: ReturnType<typeof createAgyNativeRunProfile> | undefined;
  const dispose = async () => {
    try {
      disposeCredentials?.();
    } finally {
      try {
        runProfile?.dispose();
      } finally {
        try {
          await releaseSession?.();
        } finally {
          try {
            await releaseStartup?.();
          } finally {
            await releaseProfile();
          }
        }
      }
    }
  };
  try {
    validateAgyNativeAccountMcp(home, findMonorepoRoot(process.cwd()));
    // Transport overrides own their synthetic process/authentication boundary.
    if (!options?.spawnCliOverride) await prepareAgyNativeKeychain({ profileHome: home });
    // Shared settings are an account baseline, never the current turn's policy.
    // CLI flags, the selected agent and this run's hook/MCP config own each turn.
    materializeAgyNativeSettings({
      profileHome: home,
      model: input.model,
      policy: buildAgyNativePolicy({ workspaceRoot: input.workspace }),
      retainTrustedWorkspaces: true,
    });
    retireAgyNativeLegacySkillAlias(home);
    await releaseProfile();
    runProfile = createAgyNativeRunProfile(home);
    const configHome = runProfile.home;
    const agent = materializeAgyNativeAgentFile({
      profileHome: configHome,
      catId: input.catId,
      systemPrompt: input.body,
      autoApprove: policy.permissionMode === 'always-proceed',
      tools: policy.agentTools,
    });
    materializeAgyNativeEffectGuard({
      profileHome: configHome,
      runtimeRoot: findMonorepoRoot(process.cwd()),
      readOnly: options?.toolExecutionPolicy?.mode === 'read_only',
    });
    const command = input.command ?? resolveCliCommand('agy');
    if (!command) throw new Error('AGY native CLI binary was not found');
    const profilePreflight = preflightAgyProfile(profile, {
      agyCommand: command,
      workingDirectory: policy.workspaceRoot,
    });
    if (!profilePreflight.ok) throw new Error(profilePreflight.message);
    const prior = options?.nativeSessionBinding;
    const resume =
      Boolean(options?.sessionId) &&
      prior?.v === 1 &&
      prior.carrier === 'agy_stream_json' &&
      prior.cliSessionId === options?.sessionId &&
      prior.l0Hash === agent.l0Hash &&
      prior.agentName === agent.agentName &&
      prior.workspaceRoot === policy.workspaceRoot &&
      prior.profileHome === home &&
      prior.model === input.model &&
      prior.permissionMode === policy.permissionMode;
    if (options?.sessionId && !resume) {
      throw new AgyNativeResumeMismatchError(
        'Native session binding is missing or differs from the current identity, model, workspace, profile or permissions; start a new session explicitly',
      );
    }
    if (options?.requireExactResume && !options.sessionId) {
      throw new AgyNativeResumeMismatchError('Native exact resume requires a session ID');
    }
    const sessionScope = (conversationId: string) => ({ conversationId, runHome: configHome });
    if (resume && options?.sessionId) {
      releaseSession = input.controlOperation
        ? await acquireAgyNativeProfileTurnAsync(
            home,
            ownerInvocationId,
            sessionScope(options.sessionId),
            options.signal,
          )
        : await waitForAgyNativeProfileTurn(home, ownerInvocationId, options.signal, sessionScope(options.sessionId));
    }
    const nativeInput = prepareAgyNativeInput(
      input.prompt,
      options?.contentBlocks,
      policy.workspaceRoot,
      options?.uploadDir,
    );
    const skillDirectories = await materializeAgyNativeSkills({
      profileHome: configHome,
      workspace: policy.workspaceRoot,
      runtimeRoot: findMonorepoRoot(process.cwd()),
      canonicalOnly: true,
    });
    const args = [
      `--gemini_dir=${runProfile.geminiDir}`,
      `--app_data_dir=${runProfile.appDataDir}`,
      '--add-dir',
      policy.workspaceRoot,
      ...nativeInput.accessDirectories.flatMap((directory) => ['--add-dir', directory]),
      ...skillDirectories.flatMap((directory) => ['--add-dir', directory]),
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
      message: Object.freeze({
        body: nativeInput.prompt,
        ...(nativeInput.hasAttachments ? { injectionDecision: 'adapter_native_file_attachment_references' } : {}),
      }),
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
      env: { ...isolatedOAuthEnv(home), ...executionOwnerEnv(options) },
      inheritParentEnv: false,
      bindExecutionOwner: Boolean(options?.auditContext),
      stdinInput: `${encodeAgyStreamJsonUserMessage(nativeInput.prompt)}\n`,
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
      ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
      ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
      ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
    };
    disposeCredentials = await materializeTaskMcp(configHome, input, options?.callbackEnv);
    // CLI 1.3.5 treats a concurrent index-open lock error as corruption and
    // recreates the shared database. Fence startup until verified init, never
    // model work. Acquire after the conversation lease so a same-session
    // waiter cannot block unrelated conversations behind this account fence.
    releaseStartup = await waitForAgyNativeProfileTurn(home, ownerInvocationId, options?.signal, {
      runHome: configHome,
    });
    return {
      cliOptions,
      preparedRequest,
      agentName: agent.agentName,
      permissionMode: policy.permissionMode,
      agentTools: [
        ...policy.agentTools,
        ...(input.options?.toolExecutionPolicy?.mode !== 'read_only' ? AGY_NATIVE_MCP_TOOLS : []),
      ],
      binding: {
        v: 1,
        carrier: 'agy_stream_json',
        model: input.model,
        profileHome: home,
        l0Hash: agent.l0Hash,
        workspaceRoot: policy.workspaceRoot,
        permissionMode: policy.permissionMode,
        agentName: agent.agentName,
      },
      ...(resume && options?.sessionId ? { resumeSessionId: options.sessionId } : {}),
      bindSession: async (sessionId) => {
        releaseSession ??= await acquireAgyNativeProfileTurnAsync(
          home,
          ownerInvocationId,
          sessionScope(sessionId),
          options?.signal,
        );
        await releaseStartup?.();
      },
      disposeCredentials: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
