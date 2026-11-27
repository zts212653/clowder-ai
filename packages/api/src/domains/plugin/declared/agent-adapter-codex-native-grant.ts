import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { AgentAdapterNativeRuntime } from '@clowder-ai/agent-contract';
import { resolveByAccountRef, validateRuntimeProviderBinding } from '../../../config/account-resolver.js';
import { finalizeCodexAccountEnvironment } from '../../../config/codex-account-environment.js';
import {
  codexApiSharesConversationState,
  codexCanonicalPath,
  resolveCodexAccountLaunch,
  resolveCodexApiExecutionHome,
} from '../../../config/codex-account-launch.js';
import { codexGatewayCredentialVersion } from '../../../config/codex-execution-account.js';
import { resolveCliCommand } from '../../../utils/cli-resolve.js';
import type { AgentAdapterRuntimeGrant } from './agent-adapter-access.js';
import { createAgentAdapterNativeProcess } from './agent-adapter-native-process.js';

const nativeId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const activations = new WeakMap<AbortSignal, Map<string, { home: string; credentialVersion: string }>>();

/** API-gateway exec uses a private state home. Shared accounts and interactive approval require other carriers. */
export function grantAgentAdapterCodexExec(
  request: Parameters<AgentAdapterRuntimeGrant>[0],
): AgentAdapterNativeRuntime | undefined {
  const scope = request.hostSession;
  if (!scope || !request.catId || request.activationSignal.aborted) return;
  const key = JSON.stringify([request.catId, scope.sessionId]);
  let sessions = activations.get(request.activationSignal);
  if (request.action === 'release') {
    sessions?.delete(key);
    return;
  }

  const options = scope.hostOptions;
  const account = scope.executionAccount;
  const captured = options?.codexAccountLaunch;
  if (
    !options ||
    !account ||
    !captured ||
    account.authType !== 'api_key' ||
    captured.authMode !== 'api_key' ||
    captured.managed ||
    !options.codexGatewayCredentialVersion ||
    captured.accountRef !== account.accountRef ||
    captured.accountRevision !== account.accountRevision ||
    options.codexLaunchPolicy?.sandboxMode !== 'read-only' ||
    options.codexLaunchPolicy.approvalPolicy !== 'never' ||
    options.pluginNativeLaunch ||
    options.toolExecutionPolicy ||
    options.boundedWatcher ||
    options.liveCompanion ||
    options.requiredTools?.length ||
    options.cliConfigArgs?.length ||
    options.contentBlocks?.some((block) => block.type !== 'text') ||
    !isAbsolute(scope.cwd)
  )
    return;

  const model = options.executionPreferences?.model ?? scope.model;
  const cwd = codexCanonicalPath(scope.cwd, scope.cwd);
  const readAccount = () => {
    const profile = resolveByAccountRef(captured.accountOwnerRoot, account.accountRef);
    if (
      profile?.client !== 'openai' ||
      profile.authType !== 'api_key' ||
      profile.syntheticNative ||
      !profile.apiKey ||
      !profile.baseUrl ||
      validateRuntimeProviderBinding('openai', profile, model)
    )
      throw new Error('Codex gateway account is unavailable');
    const url = new URL(profile.baseUrl);
    if (
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      codexApiSharesConversationState(profile.authType, profile.baseUrl)
    )
      throw new Error('Codex gateway account is unavailable');
    const launch = resolveCodexAccountLaunch(profile, { cwd });
    const credentialVersion = codexGatewayCredentialVersion(profile.baseUrl, profile.apiKey);
    if (
      launch.accountRevision !== captured.accountRevision ||
      launch.accountOwnerRoot !== captured.accountOwnerRoot ||
      credentialVersion !== options.codexGatewayCredentialVersion
    )
      throw new Error('Codex execution account changed');
    return {
      launch,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      credentialVersion,
      loopback: url.protocol === 'http:',
    };
  };

  if (request.action === 'openSession') {
    return {
      async prepare(input, signal) {
        signal.throwIfAborted();
        request.activationSignal.throwIfAborted();
        if (
          input.hostSessionId !== scope.sessionId ||
          input.instructions !== scope.instructions ||
          input.resumeNativeSessionId !== scope.resumeNativeSessionId ||
          (input.resumeNativeSessionId !== undefined && !nativeId.test(input.resumeNativeSessionId))
        )
          throw new Error('Codex session request is outside the Host grant');
        const { launch, baseUrl, credentialVersion } = readAccount();
        const home = resolveCodexApiExecutionHome(launch, baseUrl, cwd, {});
        await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });
        signal.throwIfAborted();
        request.activationSignal.throwIfAborted();
        sessions ??= activations.get(request.activationSignal);
        if (!sessions) activations.set(request.activationSignal, (sessions = new Map()));
        sessions.set(key, { home, credentialVersion });
        return input.resumeNativeSessionId ? { nativeSessionId: input.resumeNativeSessionId } : {};
      },
    };
  }
  if (request.action !== 'startTurn') return;
  const session = sessions?.get(key);
  if (!session || (scope.nativeSessionId !== undefined && !nativeId.test(scope.nativeSessionId))) return;
  let launched = false;
  const run = createAgentAdapterNativeProcess(async ({ hostSessionId, args, stdin }) => {
    const prefix = scope.nativeSessionId ? ['exec', 'resume', scope.nativeSessionId] : ['exec'];
    const instructions = `developer_instructions=${JSON.stringify(scope.instructions)}`;
    const expected = [
      ...prefix,
      '--json',
      '-c',
      instructions,
      ...(scope.model ? ['--model', scope.model] : []),
      '--',
      '-',
    ];
    if (
      launched ||
      hostSessionId !== scope.sessionId ||
      typeof stdin !== 'string' ||
      stdin !== scope.prompt ||
      args.length !== expected.length ||
      args.some((value, index) => value !== expected[index])
    )
      throw new Error('Codex process request is outside the Host grant');
    launched = true;
    const { launch, baseUrl, apiKey, credentialVersion, loopback } = readAccount();
    const home = resolveCodexApiExecutionHome(launch, baseUrl, cwd, {});
    if (home !== session.home || credentialVersion !== session.credentialVersion)
      throw new Error('Codex session account or workspace changed');
    const command = resolveCliCommand('codex');
    if (!command) throw new Error('Codex executable is unavailable');
    const hostArgs = [
      ...prefix,
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--disable',
      'hooks',
      '--disable',
      'plugins',
      '-c',
      instructions,
      '-c',
      'sandbox_mode="read-only"',
      '-c',
      'approval_policy="never"',
      '-c',
      'features.shell_tool=false',
      '-c',
      'web_search="disabled"',
      '-c',
      'mcp_servers={}',
      '-c',
      'apps._default.enabled=false',
      ...(loopback ? ['-c', 'features.respect_system_proxy=false'] : []),
      '-c',
      'model_provider="custom"',
      '-c',
      'model_providers.custom.name="Custom API Key"',
      '-c',
      `model_providers.custom.base_url=${JSON.stringify(baseUrl)}`,
      '-c',
      'model_providers.custom.wire_api="responses"',
      '-c',
      'model_providers.custom.env_key="OPENAI_API_KEY"',
      '-c',
      'model_providers.custom.requires_openai_auth=false',
      ...(model ? ['--model', model] : []),
      '--',
      '-',
    ];
    const env = finalizeCodexAccountEnvironment(launch, {
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? null,
        ComSpec: process.env.ComSpec ?? null,
        PATHEXT: process.env.PATHEXT ?? null,
        HOME: dirname(home),
        USERPROFILE: dirname(home),
        TEMP: join(home, 'tmp'),
        TMP: join(home, 'tmp'),
        TMPDIR: join(home, 'tmp'),
        ...(loopback ? { NO_PROXY: '127.0.0.1,localhost,::1' } : {}),
      },
      selectedApiEnv: { OPENAI_API_KEY: apiKey },
      cwd,
      args: hostArgs,
      executionHome: home,
    });
    return {
      command,
      cwd,
      env,
      args: hostArgs,
      stdinInput: stdin,
      invocationId: options.invocationId,
      assertLaunchCurrent() {
        request.activationSignal.throwIfAborted();
        const current = readAccount();
        if (current.baseUrl !== baseUrl || current.apiKey !== apiKey)
          throw new Error('Codex gateway credential changed');
      },
    };
  });
  return {
    run(input, signal) {
      return run(input, AbortSignal.any([signal, request.activationSignal]));
    },
  };
}
