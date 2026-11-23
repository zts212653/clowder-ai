import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  type AgyProfileConfig,
  type CatId,
  type CliEffortPreset,
  type NativeSessionBinding,
  resolveCliEffortOverride,
} from '@cat-cafe/shared';
import { inspectAgyLogin } from '../../../../../../config/agy-account.js';
import { buildCliNotFoundDiagnostic } from '../../../../../../utils/cli-diagnostics.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../../utils/cli-resolve.js';
import type { CliSpawnOptions } from '../../../../../../utils/cli-types.js';
import { findMonorepoRoot } from '../../../../../../utils/monorepo-root.js';
import type { LivenessWarningEvent } from '../../../../../../utils/ProcessLivenessProbe.js';
import { getDefaultUploadDir } from '../../../../../../utils/upload-paths.js';
import type { AgentServiceOptions, PreparedProviderRequestV1 } from '../../../types.js';
import { preflightAgyProfile, resolveAgyProfile, resolveAgySpawnCwd } from '../agy-profile-manager.js';
import { encodeAgyStreamJsonUserMessage } from '../agy-stream-json-parser.js';
import { materializeAgyNativeAgentFile } from './agy-native-agent-file.js';
import { materializeAgyNativeEffectGuard } from './agy-native-effect-guard.js';
import { AgyNativeResumeMismatchError, AgyNativeStartupError } from './agy-native-errors.js';
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
import {
  canResumeAgyWorkspaceScope,
  containsDirectoryPath,
  hostAgyNativeAgentName,
  matchesCatAgyAgentName,
} from './launch/agy-session-compatibility.js';
import { acquireAgyNativeProfileTurnAsync } from './profile-turn/async.js';
import { type AgyNativeApprovalBridge, startAgyNativeApprovalBridge } from './run/agy-native-approval-bridge.js';
import { type AgyCapacityScope, resolveAgyCapacityScope } from './run/agy-native-capacity-store.js';

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
  readonly onVersionWarning?: (warning: LivenessWarningEvent) => void;
}

export interface AgyNativeLaunchPlan {
  readonly cliOptions: CliSpawnOptions & { readonly cwd: string };
  readonly preparedRequest: PreparedProviderRequestV1;
  readonly agentName: string;
  readonly effectiveModel: string;
  readonly supplementalUploadDir?: string;
  readonly capacityScope?: AgyCapacityScope;
  readonly volatileL0Context: string;
  readonly permissionMode: AgyNativePermissionMode;
  readonly agentTools: readonly string[];
  readonly binding: Omit<NativeSessionBinding, 'cliSessionId'>;
  readonly resumeSessionId?: string;
  readonly bindSession: (sessionId: string) => void | Promise<void>;
  readonly disposeCredentials?: () => void | Promise<void>;
}

function isNoopProfileSkillsJson(filePath: string): boolean {
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!raw) return true;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const obj = parsed as Record<string, unknown>;
    return (
      Object.keys(obj).every((k) => k === 'entries' || k === 'inherits') &&
      (obj.entries === undefined || (Array.isArray(obj.entries) && obj.entries.length === 0)) &&
      (obj.inherits === undefined || (Array.isArray(obj.inherits) && obj.inherits.length === 0))
    );
  } catch {
    return false;
  }
}

function assertNoUntrustedProfilePrograms(home: string): void {
  for (const executable of ['plugins', 'skills.json']) {
    const candidate = join(home, '.gemini', 'config', executable);
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (
      !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      executable === 'plugins' &&
      readdirSync(candidate).length === 0
    ) {
      continue;
    }
    if (!stat.isSymbolicLink() && stat.isFile() && executable === 'skills.json' && isNoopProfileSkillsJson(candidate)) {
      continue;
    }
    throw new Error(`AGY native profile has unvalidated executable config: ${executable}`);
  }
}

function resolveAgyEffectiveModelAndEffort(
  configuredModel: string,
  override?: CliEffortPreset,
): { readonly effectiveModel: string; readonly effortArg?: string } {
  const suffixMatch = configuredModel.match(/-(low|medium|high|xhigh|max)$/i);
  const inherited = suffixMatch?.[1]?.toLowerCase() ?? 'high';
  const resolved = resolveCliEffortOverride('google', configuredModel, inherited, override);
  if (resolved.source === 'thread_override' && resolved.compatibility === 'compatible' && resolved.effective) {
    const rewrittenModel = suffixMatch
      ? `${configuredModel.slice(0, -suffixMatch[0].length)}-${resolved.effective}`
      : configuredModel;
    return { effectiveModel: rewrittenModel, effortArg: resolved.effective };
  }
  return { effectiveModel: configuredModel };
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

/** Missing AGY binary: same structured diagnostic surface as other startup failures. */
export function missingAgyNativeCliError(): AgyNativeStartupError {
  return new AgyNativeStartupError(formatCliNotFoundError('agy'), buildCliNotFoundDiagnostic('agy'));
}

/** Prepare the ordinary native tool surface with canonical MCP identity and resume provenance. */
export async function prepareAgyNativeLaunch(input: AgyNativeLaunchInput): Promise<AgyNativeLaunchPlan> {
  const options = input.options;
  const member = options?.pluginNativeLaunch;
  const readOnly = options?.toolExecutionPolicy?.mode === 'read_only';
  const interactiveApproval =
    input.profileConfig.autoApprove !== true &&
    !readOnly &&
    !member &&
    Boolean(options?.runtimeInteractionPort && options?.auditContext);
  const allowWorkspaceWrites = input.profileConfig.allowWorkspaceWrites === true && !readOnly && !member;
  const { effectiveModel, effortArg } = resolveAgyEffectiveModelAndEffort(
    input.model,
    options?.reasoningEffortOverride,
  );
  const policy = buildAgyNativePolicy({
    workspaceRoot: input.workspace,
    autoApprove: input.profileConfig.autoApprove,
    readOnly,
    allowWorkspaceWrites,
    interactiveApproval,
    ...(member ? { pluginServerName: member.server.name } : {}),
  });
  // A per-turn restriction narrows tools; it does not revoke the operator's workspace admission.
  if (input.profileConfig.autoApprove !== true)
    assertOperatorTrustedWorkspace(input.profileConfig, policy.workspaceRoot);
  const profile = resolveAgyProfile({
    materializeSettings: false,
    catId: input.catId,
    expectedModel: effectiveModel,
    workingDirectory: policy.workspaceRoot,
    config: { ...input.profileConfig, model: effectiveModel },
  });
  if (!profile) throw new Error('AGY native isolated profile is disabled');
  const home = realpathSync(profile.homePath);
  if (containsDirectoryPath(home, policy.workspaceRoot) || containsDirectoryPath(policy.workspaceRoot, home)) {
    throw new Error('AGY native profile HOME overlaps the model-readable workspace');
  }
  assertNoUntrustedProfilePrograms(home);
  const ownerInvocationId = options?.auditContext?.invocationId ?? options?.invocationId;
  const releaseProfile = await waitForAgyNativeProfileTurn(home, ownerInvocationId, options?.signal, {
    preparation: true,
  });
  let disposeCredentials: (() => void) | undefined;
  let approvalBridge: AgyNativeApprovalBridge | undefined;
  let releaseSession: (() => Promise<void>) | undefined;
  let releaseStartup: (() => Promise<void>) | undefined;
  let releaseAccountStartup: (() => Promise<void>) | undefined;
  let runProfile: ReturnType<typeof createAgyNativeRunProfile> | undefined;
  const dispose = async () => {
    try {
      disposeCredentials?.();
    } finally {
      try {
        await approvalBridge?.dispose();
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
              try {
                await releaseAccountStartup?.();
              } finally {
                await releaseProfile();
              }
            }
          }
        }
      }
    }
  };
  try {
    validateAgyNativeAccountMcp(home, findMonorepoRoot(process.cwd()));
    // Transport overrides own their synthetic process/authentication boundary.
    const account = options?.agyAccount;
    if (account) {
      const status = inspectAgyLogin(account.credentialHome);
      if (status !== 'ready' && status !== 'refreshable')
        throw new Error('AGY 账号未登录或登录文件读不到，请先在账号页完成官方登录');
    } else if (!options?.spawnCliOverride) await prepareAgyNativeKeychain({ profileHome: home });
    // Shared settings remain a conservative account baseline; per-turn --settings
    // in runProfile.home owns the exact current turn policy (fixing sandbox EPERM).
    if (!member) {
      materializeAgyNativeSettings({
        profileHome: home,
        model: effectiveModel,
        policy: buildAgyNativePolicy({ workspaceRoot: input.workspace }),
        retainTrustedWorkspaces: true,
        tolerateUnknownKeys: true,
      });
      retireAgyNativeLegacySkillAlias(home);
    }
    runProfile = createAgyNativeRunProfile(home, account?.credentialHome);
    await releaseProfile();
    const configHome = runProfile.home;
    mkdirSync(join(configHome, '.gemini/antigravity-cli'), { mode: 0o700 });
    const runSettingsPath = materializeAgyNativeSettings({
      profileHome: configHome,
      model: effectiveModel,
      policy,
    });
    const agent = materializeAgyNativeAgentFile({
      profileHome: configHome,
      catId: input.catId,
      systemPrompt: input.body,
      ...(options?.frozenL0Input ? { frozenL0Input: options.frozenL0Input } : {}),
      autoApprove: policy.permissionMode === 'always-proceed',
      readOnly,
      scopedMember: Boolean(member),
      tools: policy.agentTools,
    });
    if (interactiveApproval && options?.runtimeInteractionPort && options?.auditContext) {
      approvalBridge = await startAgyNativeApprovalBridge({
        runHome: configHome,
        runtimeInteractionPort: options.runtimeInteractionPort,
        auditContext: options.auditContext,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    const requireGuardApproval =
      interactiveApproval || (input.profileConfig.autoApprove !== true && allowWorkspaceWrites);
    materializeAgyNativeEffectGuard({
      profileHome: configHome,
      accountHome: home,
      ...(account ? { credentialHome: account.credentialHome } : {}),
      runtimeRoot: findMonorepoRoot(process.cwd()),
      workspaceRoot: policy.workspaceRoot,
      readOnly,
      ...(member ? { pluginServerName: member.server.name } : {}),
      ...(requireGuardApproval ? { requireApproval: true } : {}),
      ...(allowWorkspaceWrites ? { allowWorkspaceWrites: true } : {}),
      ...(approvalBridge ? { approvalBridgeFile: approvalBridge.bridgeFile } : {}),
    });
    const command = input.command ?? resolveCliCommand('agy');
    if (!command) throw missingAgyNativeCliError();
    const profilePreflight = preflightAgyProfile(
      { ...profile, settingsPath: runSettingsPath },
      {
        agyCommand: command,
        workingDirectory: policy.workspaceRoot,
      },
    );
    if (!profilePreflight.ok) throw new Error(profilePreflight.message);

    const prior = options?.nativeSessionBinding;
    const priorAgentMatch = prior ? matchesCatAgyAgentName(prior.agentName, input.catId) : null;
    const resume =
      Boolean(options?.sessionId) &&
      prior?.v === 1 &&
      prior.carrier === 'agy_stream_json' &&
      prior.cliSessionId === options?.sessionId &&
      prior.profileHome === home &&
      priorAgentMatch?.matches === true &&
      !(priorAgentMatch.bornReadOnly && !readOnly) &&
      canResumeAgyWorkspaceScope({
        priorWorkspaceRoot: prior.workspaceRoot,
        nextWorkspaceRoot: policy.workspaceRoot,
        profileHome: home,
        autoApprove: input.profileConfig.autoApprove === true,
        trustedWorkspaces: input.profileConfig.trustedWorkspaces,
      });
    if (options?.sessionId && !resume) {
      throw new AgyNativeResumeMismatchError(
        'Native session binding is missing, belongs to another carrier/member/profile, or crosses an unrelated workspace boundary; start a new session explicitly',
      );
    }
    if (options?.requireExactResume && !options.sessionId) {
      throw new AgyNativeResumeMismatchError('Native exact resume requires a session ID');
    }
    const trajectoryBornReadOnly = resume && priorAgentMatch ? priorAgentMatch.bornReadOnly : readOnly;
    const durableAgentName = member
      ? agent.agentName
      : hostAgyNativeAgentName(input.catId, trajectoryBornReadOnly ? 'readonly' : 'normal');

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
    if (member) mkdirSync(join(configHome, '.gemini/config/skills'), { mode: 0o700 });
    const skillDirectories = member
      ? []
      : await materializeAgyNativeSkills({
          profileHome: configHome,
          workspace: policy.workspaceRoot,
          runtimeRoot: findMonorepoRoot(process.cwd()),
          canonicalOnly: true,
        });
    let canonicalUploadDir: string | undefined;
    if (!member) {
      try {
        const candidateUpload = getDefaultUploadDir(options?.uploadDir ?? process.env.UPLOAD_DIR);
        if (!existsSync(candidateUpload) && options?.activeRunDispatch)
          mkdirSync(candidateUpload, { recursive: true, mode: 0o700 });
        if (existsSync(candidateUpload) && lstatSync(candidateUpload).isDirectory()) {
          canonicalUploadDir = realpathSync(candidateUpload);
        }
      } catch {
        // Without an actual launch grant, supplemental external images must be rejected.
      }
    }
    const args = [
      `--gemini_dir=${runProfile.geminiDir}`,
      `--app_data_dir=${runProfile.appDataDir}`,
      ...(!member ? ['--add-dir', policy.workspaceRoot] : []),
      ...(!member ? nativeInput.accessDirectories.flatMap((directory) => ['--add-dir', directory]) : []),
      ...(canonicalUploadDir &&
      canonicalUploadDir !== policy.workspaceRoot &&
      !nativeInput.accessDirectories.includes(canonicalUploadDir)
        ? ['--add-dir', canonicalUploadDir]
        : []),
      ...skillDirectories.flatMap((directory) => ['--add-dir', directory]),
      ...policy.cliArgs,
      ...(member ? ['--disable-slash-commands', '--new-project'] : []),
      '--settings',
      runSettingsPath,
      '--agent',
      agent.agentName,
      '--model',
      effectiveModel,
      ...(effortArg ? ['--effort', effortArg] : []),
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
        { body: agent.nativeInstructionBody, injectionDecision: 'native_agent_file_compiled' },
      ]),
      runtime: Object.freeze({
        provider: 'google',
        carrier: 'antigravity_cli',
        model: effectiveModel,
        protocol: 'stream-json',
      }),
      tools: Object.freeze({ finalSurface: 'unknown' as const }),
      providerNativeVisibility: 'unknown',
    });
    const env = { ...isolatedOAuthEnv(home, options?.accountEnv), ...executionOwnerEnv(options) };
    if (account) env.SSH_TTY = 'cat-cafe-file-auth';
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
    // Runtime discovery must not occupy a profile/account's short CLI-init critical section.
    const capacityScope = await resolveAgyCapacityScope({
      command,
      profileHome: home,
      credentialHome: account?.credentialHome,
      model: effectiveModel,
      signal: options?.signal,
      invocationId: options?.invocationId,
      livenessProbe: options?.livenessProbe,
      onVersionWarning: input.onVersionWarning,
    });
    releaseStartup = await waitForAgyNativeProfileTurn(home, ownerInvocationId, options?.signal, {
      runHome: configHome,
    });
    if (account)
      releaseAccountStartup = await waitForAgyNativeProfileTurn(
        account.credentialHome,
        ownerInvocationId,
        options?.signal,
      );
    return {
      cliOptions,
      preparedRequest,
      agentName: agent.agentName,
      effectiveModel,
      supplementalUploadDir: canonicalUploadDir,
      capacityScope,
      volatileL0Context: '',
      permissionMode: policy.permissionMode,
      agentTools: [
        ...policy.agentTools,
        ...(member ? ['call_mcp_tool'] : []),
        ...(!member && !readOnly ? AGY_NATIVE_MCP_TOOLS : []),
      ],
      binding: {
        v: 1,
        carrier: 'agy_stream_json',
        model: effectiveModel,
        profileHome: home,
        l0Hash: agent.l0Hash,
        workspaceRoot: policy.workspaceRoot,
        permissionMode: policy.permissionMode,
        agentName: durableAgentName,
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
        await releaseAccountStartup?.();
      },
      disposeCredentials: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
