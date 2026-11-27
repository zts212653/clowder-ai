import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { isCliPlainTextResult, spawnCli } from '../../../utils/cli-spawn.js';
import { resolveCliCommand } from '../../../utils/cli-resolve.js';
import type { AgentAdapterRuntimeGrant } from './agent-adapter-access.js';
import { createAgentAdapterNativeProcess } from './agent-adapter-native-process.js';

const nativeId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const envKeys = [
  'PATH',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'NO_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
] as const;

type Session = {
  readonly dir: string;
  readonly agentFile: string;
  readonly nativeSessionId?: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly model?: string;
};

const activations = new WeakMap<AbortSignal, Map<string, Session>>();

function environment(source: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of envKeys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  for (const key of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'] as const) {
    const value = process.env[key];
    if (env[key] === undefined && typeof value === 'string' && value.length > 0) env[key] = value;
  }
  if (!env.HOME && !env.USERPROFILE && !env.CLAUDE_CONFIG_DIR)
    throw new Error('Claude execution home is unavailable');
  return env;
}

function expectedArgs(session: Session): string[] {
  const args = [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--system-prompt-file',
    session.agentFile,
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    '',
  ];
  if (session.nativeSessionId) args.push('--resume', session.nativeSessionId);
  if (session.model) args.push('--model', session.model);
  return args;
}

async function cleanup(session: Session): Promise<void> {
  await rm(session.dir, { recursive: true, force: true, maxRetries: 2 });
}

/**
 * Claude Code print-mode candidate.
 *
 * The default grant is responsible for the catalog provenance gate. This body
 * additionally binds every call to the Host session, worktree, execution
 * account and exact argv/stdin approved for that session. It never sees a
 * plugin-supplied executable or environment.
 */
export const grantAgentAdapterClaudePrint: AgentAdapterRuntimeGrant = (request) => {
  if (request.activationSignal.aborted) return;
  if (request.action === 'detect') return { inspect: inspectClaudeCode };
  const scope = request.hostSession;
  if (!scope || !request.catId || !isAbsolute(scope.cwd) || !scope.instructions.trim()) return;
  const account = scope.executionAccount;
  if (!account?.accountRef || !account.accountRevision) return;

  if (request.action === 'release') {
    const sessions = activations.get(request.activationSignal);
    const session = sessions?.get(JSON.stringify([request.catId, scope.sessionId]));
    sessions?.delete(JSON.stringify([request.catId, scope.sessionId]));
    if (session) void cleanup(session);
    return;
  }
  if (request.action !== 'openSession' && request.action !== 'startTurn') return;

  const key = JSON.stringify([request.catId, scope.sessionId]);
  const existingSessions = activations.get(request.activationSignal);
  const sessions = existingSessions ?? new Map<string, Session>();
  if (!existingSessions) {
    activations.set(request.activationSignal, sessions);
    request.activationSignal.addEventListener(
      'abort',
      () => {
        for (const session of sessions.values()) void cleanup(session);
        sessions.clear();
      },
      { once: true },
    );
  }

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
          throw new Error('Claude session request is outside the Host grant');
        const env = environment(scope.hostOptions?.callbackEnv);
        const previous = sessions.get(key);
        if (previous) {
          sessions.delete(key);
          await cleanup(previous);
        }
        const dir = await mkdtemp(join(tmpdir(), 'claude-adapter-'));
        try {
          const agentFile = join(dir, 'identity.txt');
          await writeFile(agentFile, input.instructions, { mode: 0o600, flag: 'wx' });
          sessions.set(key, {
            dir,
            agentFile,
            nativeSessionId: input.resumeNativeSessionId,
            cwd: scope.cwd,
            env,
            ...(scope.model === undefined ? {} : { model: scope.model }),
          });
          return input.resumeNativeSessionId
            ? { nativeSessionId: input.resumeNativeSessionId, agentFile }
            : { agentFile };
        } catch (error) {
          await rm(dir, { recursive: true, force: true });
          throw error;
        }
      },
    };
  }

  const session = sessions.get(key);
  if (!session) return;
  return {
    run: createAgentAdapterNativeProcess(async ({ hostSessionId, args, stdin }) => {
      const expected = expectedArgs(session);
      if (
        hostSessionId !== scope.sessionId ||
        typeof stdin !== 'string' ||
        stdin !== scope.prompt ||
        args.length !== expected.length ||
        args.some((value, index) => value !== expected[index])
      )
        throw new Error('Claude process request is outside the Host grant');
      await scope.hostOptions?.beforeProviderLaunch?.({
        v: 1,
        message: { body: stdin },
        nativeInstructions: [{ body: scope.instructions, injectionDecision: 'native_l0_compiled' }],
        runtime: {
          provider: 'anthropic',
          carrier: 'print_sdk',
          protocol: 'stream-json',
          ...(session.model ? { model: session.model } : {}),
          toolExecutionPolicy: 'read_only',
        },
        tools: { finalSurface: 'exact', catCafeSchemas: [] },
        providerNativeVisibility: 'unknown',
      });
      const command = resolveCliCommand('claude');
      if (!command) throw new Error('Claude Code executable is unavailable');
      return {
        command,
        cwd: session.cwd,
        env: session.env,
        args: expected,
        stdinInput: stdin,
        timeoutMs: 120_000,
        bindExecutionOwner: false,
      };
    }),
  };
};

/** Isolated version probe for the independent candidate test; the default grant has its own. */
export async function inspectClaudeCode(signal: AbortSignal): Promise<
  | { status: 'ready'; version: string }
  | { status: 'not-installed' }
  | { status: 'unavailable'; reason: string }
> {
  signal.throwIfAborted();
  const command = resolveCliCommand('claude');
  if (!command) return { status: 'not-installed' };
  const tempRoot = tmpdir();
  const home = await mkdtemp(join(tempRoot, 'claude-version-probe-'));
  try {
    const env = environment({
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      TEMP: home,
      TMP: home,
      PATH: process.env.PATH ?? '',
    });
    for await (const result of spawnCli({
      command,
      args: ['--version'],
      cwd: home,
      env,
      signal,
      timeoutMs: 8_000,
      bindExecutionOwner: false,
      inheritParentEnv: false,
      outputMode: 'plainText',
      assertLaunchCurrent: () => signal.throwIfAborted(),
    })) {
      if (!isCliPlainTextResult(result) || result.exitCode !== 0) continue;
      const version = /\b\d+\.\d+\.\d+(?:[-+][\w.+-]+)?\b/.exec(result.stdout || result.stderr)?.[0];
      if (version) return { status: 'ready', version };
    }
  } catch {
    signal.throwIfAborted();
  } finally {
    if (dirname(home) === tempRoot) await rm(home, { recursive: true, force: true, maxRetries: 2 });
  }
  return { status: 'unavailable', reason: 'native_version_probe_failed' };
}
