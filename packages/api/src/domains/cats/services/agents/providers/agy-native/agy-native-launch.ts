import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AgyProfileConfig, CatId, NativeSessionBinding } from '@cat-cafe/shared';
import { resolveCliCommand } from '../../../../../../utils/cli-resolve.js';
import type { CliSpawnOptions } from '../../../../../../utils/cli-types.js';
import { findMonorepoRoot } from '../../../../../../utils/monorepo-root.js';
import type { AgentServiceOptions, PreparedProviderRequestV1 } from '../../../types.js';
import { preflightAgyProfile, resolveAgyProfile, resolveAgySpawnCwd } from '../agy-profile-manager.js';
import { encodeAgyStreamJsonUserMessage } from '../agy-stream-json-parser.js';
import { materializeAgyNativeAgentFile } from './agy-native-agent-file.js';
import { materializeAgyNativeEffectGuard } from './agy-native-effect-guard.js';
import { AgyNativeResumeMismatchError } from './agy-native-errors.js';
import { prepareAgyNativeInput } from './agy-native-input.js';
import { prepareAgyNativeKeychain } from './agy-native-keychain.js';
import { validateAgyNativeAccountMcp } from './agy-native-mcp-config.js';
import { type AgyNativePermissionMode, buildAgyNativePolicy } from './agy-native-policy.js';
import { waitForAgyNativeProfileTurn } from './agy-native-profile-turn.js';
import { createAgyNativeRunProfile } from './agy-native-run-profile.js';
import { materializeAgyNativeSettings } from './agy-native-settings.js';
import { materializeAgyNativeSkills, retireAgyNativeLegacySkillAlias } from './agy-native-skills.js';
import { AGY_NATIVE_MCP_TOOLS } from './agy-native-tools.js';
import { executionOwnerEnv, isolatedOAuthEnv } from './launch/agy-native-launch-env.js';
import { materializeAgyLaunchMcp } from './launch/agy-native-launch-mcp.js';
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
  readonly volatileL0Context: string;
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

function matchesAgyNativeBindingL0(
  prior: NativeSessionBinding,
  catId: CatId,
  agent: { readonly l0Hash: string; readonly agentName: string },
  fullSystemPrompt: string,
): boolean {
  if (prior.l0Hash === agent.l0Hash) return prior.agentName === agent.agentName;
  const legacyFullHash = createHash('sha256').update(fullSystemPrompt).digest('hex');
  if (prior.l0Hash !== legacyFullHash) return false;
  const prefix = `cat-cafe-${catId}-`;
  const suffix = agent.agentName.slice(prefix.length + 16);
  const expectedLegacyAgentName = `${prefix}${legacyFullHash.slice(0, 16)}${suffix}`;
  return prior.agentName === expectedLegacyAgentName;
}

/** Prepare the ordinary native tool surface with canonical MCP identity and resume provenance. */
export async function prepareAgyNativeLaunch(input: AgyNativeLaunchInput): Promise<AgyNativeLaunchPlan> {
  const options = input.options;
  const member = options?.pluginNativeLaunch;
  const policy = buildAgyNativePolicy({
    workspaceRoot: input.workspace,
    autoApprove: input.profileConfig.autoApprove,
    readOnly: options?.toolExecutionPolicy?.mode === 'read_only',
    ...(member ? { pluginServerName: member.server.name } : {}),
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
    if (!member) {
      materializeAgyNativeSettings({
        profileHome: home,
        model: input.model,
        policy: buildAgyNativePolicy({ workspaceRoot: input.workspace }),
        retainTrustedWorkspaces: true,
      });
      retireAgyNativeLegacySkillAlias(home);
    }
    await releaseProfile();
    runProfile = createAgyNativeRunProfile(home);
    const configHome = runProfile.home;
    let memberSettingsPath: string | undefined;
    if (member) {
      mkdirSync(join(configHome, '.gemini/antigravity-cli'), { mode: 0o700 });
      memberSettingsPath = materializeAgyNativeSettings({ profileHome: configHome, model: input.model, policy });
    }
    const agent = materializeAgyNativeAgentFile({
      profileHome: configHome,
      catId: input.catId,
      systemPrompt: input.body,
      ...(options?.frozenL0Input ? { frozenL0Input: options.frozenL0Input } : {}),
      autoApprove: policy.permissionMode === 'always-proceed',
      tools: policy.agentTools,
    });
    materializeAgyNativeEffectGuard({
      profileHome: configHome,
      accountHome: home,
      runtimeRoot: findMonorepoRoot(process.cwd()),
      workspaceRoot: policy.workspaceRoot,
      readOnly: options?.toolExecutionPolicy?.mode === 'read_only',
      ...(member ? { pluginServerName: member.server.name } : {}),
    });
    const command = input.command ?? resolveCliCommand('agy');
    if (!command) throw new Error('AGY native CLI binary was not found');
    const profilePreflight = preflightAgyProfile(
      memberSettingsPath ? { ...profile, settingsPath: memberSettingsPath } : profile,
      {
        agyCommand: command,
        workingDirectory: policy.workspaceRoot,
      },
    );
    if (!profilePreflight.ok) throw new Error(profilePreflight.message);
    const prior = options?.nativeSessionBinding;
    const resume =
      Boolean(options?.sessionId) &&
      prior?.v === 1 &&
      prior.carrier === 'agy_stream_json' &&
      prior.cliSessionId === options?.sessionId &&
      matchesAgyNativeBindingL0(prior, input.catId, agent, input.body) &&
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
    const allowDynamicL0 = input.controlOperation !== 'compact' && !member;
    const volatileL0Context = allowDynamicL0 ? agent.volatileL0Context : '';
    const nativeInput = prepareAgyNativeInput(
      input.prompt,
      options?.contentBlocks,
      policy.workspaceRoot,
      options?.uploadDir,
      volatileL0Context,
    );
    if (member) mkdirSync(join(configHome, '.gemini/config/skills'), { mode: 0o700 });
    const skillDirectories = member
      ? []
      : await materializeAgyNativeSkills({
          profileHome: configHome,
          workspace: policy.workspaceRoot,
          runtimeRoot: findMonorepoRoot(process.cwd()),
          canonicalOnly: true,
        });
    const args = [
      `--gemini_dir=${runProfile.geminiDir}`,
      `--app_data_dir=${runProfile.appDataDir}`,
      ...(!member ? ['--add-dir', policy.workspaceRoot] : []),
      ...(!member ? nativeInput.accessDirectories.flatMap((directory) => ['--add-dir', directory]) : []),
      ...skillDirectories.flatMap((directory) => ['--add-dir', directory]),
      ...policy.cliArgs,
      ...(memberSettingsPath ? ['--disable-slash-commands', '--new-project', '--settings', memberSettingsPath] : []),
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
        ...(nativeInput.injectionDecision ? { injectionDecision: nativeInput.injectionDecision } : {}),
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
    const env = { ...isolatedOAuthEnv(home), ...executionOwnerEnv(options) };
    const cliOptions: CliSpawnOptions & { readonly cwd: string } = {
      command,
      args,
      cwd: resolveAgySpawnCwd(profile, input.catId, policy.workspaceRoot),
      env,
      inheritParentEnv: false,
      bindExecutionOwner: Boolean(options?.auditContext),
      stdinInput: `${encodeAgyStreamJsonUserMessage(nativeInput.prompt)}\n`,
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
      ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
      ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
      ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
    };
    disposeCredentials = await materializeAgyLaunchMcp(configHome, input, options?.callbackEnv);
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
      volatileL0Context,
      permissionMode: policy.permissionMode,
      agentTools: [
        ...policy.agentTools,
        ...(member ? ['call_mcp_tool'] : []),
        ...(!member && input.options?.toolExecutionPolicy?.mode !== 'read_only' ? AGY_NATIVE_MCP_TOOLS : []),
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
