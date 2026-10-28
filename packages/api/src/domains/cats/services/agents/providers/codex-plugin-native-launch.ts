import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pluginMcpEnvironment } from '../../../../../config/capabilities/plugin-mcp-environment.js';
import { finalizeCodexAccountEnvironment } from '../../../../../config/codex-account-environment.js';
import { codexManagedLaunchArgs } from '../../../../../config/codex-managed-launch.js';
import type { NativeMcpServer } from '../../../../plugin/declared/native-mcp-launches.js';
import type { AgentServiceOptions } from '../../types.js';
import { normalizeToolExecutionPolicy } from '../invocation/tool-execution-policy.js';
import { normalizeCodexMcpConfigArgs } from './codex-config-overrides.js';
import { CODEX_LIVE_DISABLED_FEATURES } from './codex-live-policy.js';

const AUTH_KEYS = ['OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID'] as const;
const MINIMAL_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

type LinkFile = (target: string, path: string) => void;

/** Windows standard users cannot create file symlinks without Developer Mode.
 * Keep the failure closed, but make the missing prerequisite diagnosable instead
 * of surfacing a raw EPERM from an internal temporary path.
 */
export function linkCodexPluginAuth(
  authFile: string,
  target: string,
  link: LinkFile = symlinkSync,
  platform: NodeJS.Platform = process.platform,
): void {
  try {
    link(authFile, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      throw Object.assign(
        new Error(
          'plugin_native_auth_link_unavailable: native OAuth requires linking auth.json into a private Codex home, but this Windows user cannot create symlinks. Enable Developer Mode/symlink privilege or use API-key authentication.',
        ),
        { code: 'PLUGIN_NATIVE_AUTH_LINK_UNAVAILABLE', cause: error },
      );
    }
    throw error;
  }
}

export interface PreparedCodexNativeLaunch {
  readonly kind: 'public';
  readonly options: AgentServiceOptions;
  readonly env: Record<string, string>;
  readonly args: readonly string[];
  readonly serverName: string;
  assertCurrent(): Promise<void>;
  dispose(): void;
}

/** Host-only port. It does not discover authority, ambient MCPs, or provider support. */
export async function prepareCodexNativeLaunch(
  options: AgentServiceOptions,
  carrier: string,
  frozenPrompt: boolean,
): Promise<PreparedCodexNativeLaunch> {
  const port = options.pluginNativeLaunch;
  if (
    !port ||
    typeof port.assertCurrent !== 'function' ||
    port.sandbox?.kind !== 'public' ||
    options.toolExecutionPolicy?.mode !== 'plugin_native' ||
    carrier !== 'exec_json' ||
    !frozenPrompt ||
    options.sessionId ||
    options.liveCompanion ||
    options.requiredTools?.length ||
    options.spawnCliOverride ||
    options.agentCarrierSessionFactory ||
    options.contentBlocks?.length ||
    options.systemPrompt ||
    !options.signal
  )
    throw new Error('plugin_native_launch_unavailable');

  const policy = normalizeToolExecutionPolicy(options.toolExecutionPolicy);
  const attempt = new AbortController();
  const server = snapshotServer(port.server);
  const workspace = port.sandbox.workspaceRoot;
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || options.workingDirectory !== workspace)
    throw new Error('plugin_native_workspace_mismatch');
  const canonicalWorkspace = realpathSync(workspace);
  const workspaceStat = statSync(canonicalWorkspace);
  if (!workspaceStat.isDirectory() || (workspaceStat.mode & 0o077) !== 0)
    throw new Error('plugin_native_workspace_not_private');
  const assertAdmission = port.assertCurrent.bind(port);
  const signal = AbortSignal.any([options.signal, attempt.signal]);
  const checkCurrent = async () => {
    signal?.throwIfAborted();
    await assertAdmission();
    signal?.throwIfAborted();
    const currentWorkspace = statSync(canonicalWorkspace);
    if (
      realpathSync(workspace) !== canonicalWorkspace ||
      currentWorkspace.dev !== workspaceStat.dev ||
      currentWorkspace.ino !== workspaceStat.ino ||
      (currentWorkspace.mode & 0o077) !== 0
    ) {
      throw new Error('plugin_native_workspace_changed');
    }
  };
  const assertCurrent = async () => {
    try {
      await checkCurrent();
    } catch (error) {
      attempt?.abort(error);
      throw error;
    }
  };
  // Capture every mutable launch input before the first await, including credentials.
  const callbackEnv = { ...options.callbackEnv };
  const accountEnv = { ...options.accountEnv };
  const accountLaunch = options.codexAccountLaunch ? structuredClone(options.codexAccountLaunch) : undefined;
  const credentialHome = accountLaunch?.credentialHome ?? (process.env.CODEX_HOME || join(homedir(), '.codex'));
  if (!callbackEnv.CAT_CAFE_INVOCATION_ID || !callbackEnv.CAT_CAFE_CALLBACK_TOKEN) {
    throw new Error('plugin_native_invocation_credentials_missing');
  }
  const captured: AgentServiceOptions = {
    ...options,
    signal,
    workingDirectory: canonicalWorkspace,
    callbackEnv,
    accountEnv,
    ...(accountLaunch ? { codexAccountLaunch: accountLaunch } : {}),
    toolExecutionPolicy: policy,
    cliConfigArgs: [],
  };
  await assertCurrent();

  const controlRoot = realpathSync(mkdtempSync(join(tmpdir(), 'codex-plugin-native-')));
  const dispose = () => rmSync(controlRoot, { recursive: true, force: true });
  try {
    const home = join(controlRoot, 'home');
    const codexHome = join(home, '.codex');
    const scratch = join(controlRoot, 'tmp');
    const pluginHome = join(controlRoot, 'plugin-home');
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(scratch, { mode: 0o700 });
    mkdirSync(pluginHome, { mode: 0o700 });
    const env: Record<string, string> = { HOME: home, CODEX_HOME: codexHome, TMPDIR: scratch, PATH: MINIMAL_PATH };
    if (process.platform === 'win32') env.USERPROFILE = home;
    const mode = accountLaunch?.authMode ?? callbackEnv.CODEX_AUTH_MODE?.trim().toLowerCase();
    if (mode === 'api_key' || mode === 'auto') {
      for (const key of AUTH_KEYS) {
        const value = accountEnv[key] ?? callbackEnv[key];
        if (value) env[key] = value;
      }
    }
    if (mode !== 'api_key') {
      // Project only the existing account's auth file, never user config/rules/plugins.
      const auth = realpathSync(join(credentialHome, 'auth.json'));
      if (!statSync(auth).isFile()) throw new Error('plugin_native_auth_file_unavailable');
      linkCodexPluginAuth(auth, join(codexHome, 'auth.json'));
    }

    if (!callbackEnv.CAT_CAFE_CREDENTIAL_FILE && !callbackEnv.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE) {
      const credentialFile = join(controlRoot, 'invocation.json');
      writeFileSync(
        credentialFile,
        JSON.stringify({
          invocationId: callbackEnv.CAT_CAFE_INVOCATION_ID,
          callbackToken: callbackEnv.CAT_CAFE_CALLBACK_TOKEN,
        }),
        { mode: 0o600, flag: 'wx' },
      );
      callbackEnv.CAT_CAFE_CREDENTIAL_FILE = credentialFile;
    }
    const pluginEnv = pluginMcpEnvironment({ source: 'plugin', env: { ...server.env } }, callbackEnv);
    const directEnv = { ...pluginEnv };
    if (directEnv.CAT_CAFE_CREDENTIAL_FILE || directEnv.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE) {
      delete directEnv.CAT_CAFE_CALLBACK_TOKEN;
      delete directEnv.CAT_CAFE_INVOCATION_ID;
    }
    // The admitted plugin receives only its explicit activation environment.
    // Native env_vars projects names, so values never enter argv or a wrapper.
    Object.assign(env, directEnv, { HOME: home, CODEX_HOME: codexHome, TMPDIR: scratch, PATH: MINIMAL_PATH });
    const nativeServer = `{${JSON.stringify(server.name)}={command=${JSON.stringify(server.command)},args=[${server.args.map((value) => JSON.stringify(value)).join(',')}],cwd=${JSON.stringify(server.workingDirectory)},env={HOME=${JSON.stringify(pluginHome)},TMPDIR=${JSON.stringify(scratch)},PATH=${JSON.stringify(MINIMAL_PATH)}},env_vars=[${Object.keys(
      directEnv,
    )
      .filter((key) => !['HOME', 'PATH', 'TMPDIR', 'CODEX_HOME'].includes(key))
      .map((value) => JSON.stringify(value))
      .join(',')}],enabled=true}}`;
    const args = [
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--ephemeral',
      '--skip-git-repo-check',
      '--config',
      'project_doc_max_bytes=0',
      '--config',
      'skills.include_instructions=false',
      '--config',
      'orchestrator.skills.enabled=false',
      '--config',
      'orchestrator.mcp.enabled=false',
      '--config',
      'default_permissions="plugin_native_public"',
      '--config',
      'permissions.plugin_native_public.filesystem={"/"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"}',
      '--config',
      'permissions.plugin_native_public.network={enabled=false}',
      '--config',
      'approval_policy="never"',
      '--config',
      'web_search="disabled"',
      '--config',
      'apps._default.enabled=false',
      '--config',
      `mcp_servers=${nativeServer}`,
      ...[...CODEX_LIVE_DISABLED_FEATURES, 'multi_agent', 'hooks'].flatMap((feature) => [
        '--config',
        `features.${feature}=false`,
      ]),
      '--config',
      'features.code_mode_host=true',
      '--config',
      'features.skip_host_skill_discovery=true',
    ];
    if (accountLaunch) {
      args.push(...codexManagedLaunchArgs({ ...accountLaunch, sqliteHome: codexHome }, []));
      const finalized = finalizeCodexAccountEnvironment(accountLaunch, {
        env,
        selectedApiEnv: accountEnv,
        args,
        cwd: canonicalWorkspace,
        executionHome: codexHome,
      });
      for (const [key, value] of Object.entries(finalized)) {
        if (value === null) delete env[key];
        else env[key] = value;
      }
    }
    return {
      kind: 'public',
      options: captured,
      env,
      args: Object.freeze(normalizeCodexMcpConfigArgs(args)),
      serverName: server.name,
      assertCurrent,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

function snapshotServer(server: NativeMcpServer): NativeMcpServer {
  if (
    !server ||
    server.transport !== 'stdio' ||
    typeof server.name !== 'string' ||
    !server.name ||
    /[\u0000-\u001f]/.test(server.name) ||
    typeof server.command !== 'string' ||
    !isAbsolute(server.command) ||
    server.command.includes('\0') ||
    typeof server.workingDirectory !== 'string' ||
    !isAbsolute(server.workingDirectory) ||
    server.workingDirectory.includes('\0') ||
    !Array.isArray(server.args) ||
    !server.args.every((arg) => typeof arg === 'string' && !arg.includes('\0')) ||
    !server.env?.CLOWDER_PLUGIN_ACTION_TOKEN ||
    !Object.entries(server.env).every(
      ([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0'),
    )
  )
    throw new Error('plugin_native_descriptor_invalid');
  return Object.freeze({ ...server, args: Object.freeze([...server.args]), env: Object.freeze({ ...server.env }) });
}
