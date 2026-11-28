import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { resolveByAccountRef, validateRuntimeProviderBinding } from '../../../../config/account-resolver.js';
import { claudeExecutionAccountSnapshot } from '../../../../config/claude-token-account.js';
import { resolveCliCommand } from '../../../../utils/cli-resolve.js';
import { resolveCatCafeDataRoot } from '../../../../utils/cli-process-ownership.js';
import type { AgentAdapterRuntimeGrant } from '../agent-adapter-access.js';
import { createAgentAdapterNativeProcess } from './agent-adapter-native-process.js';

const nativeId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
type Session = { dir: string; file: string; home: string; cwd: string; projectRoot: string; fingerprint: string };
const activations = new WeakMap<AbortSignal, Map<string, Session>>();

function cleanup(session: Session) {
  return rm(session.dir, { recursive: true, force: true, maxRetries: 2 });
}

/** Tool-free print mode for an explicitly selected catalog API key and gateway. */
export const grantAgentAdapterClaudePrint: AgentAdapterRuntimeGrant = (request) => {
  const scope = request.hostSession;
  if (!scope || !request.catId || request.activationSignal.aborted) return;
  const key = JSON.stringify([request.catId, scope.sessionId]);
  let sessions = activations.get(request.activationSignal);
  if (request.action === 'release') {
    const session = sessions?.get(key);
    sessions?.delete(key);
    if (session) void cleanup(session).catch(() => {});
    return;
  }
  if (request.action !== 'openSession' && request.action !== 'startTurn') return;

  const options = scope.hostOptions;
  const account = scope.executionAccount;
  const projectRoot = options?.executionAccountProjectRoot;
  if (
    !options ||
    !projectRoot ||
    !isAbsolute(projectRoot) ||
    !isAbsolute(scope.cwd) ||
    account?.authType !== 'api_key' ||
    options.pluginNativeLaunch ||
    options.toolExecutionPolicy ||
    options.boundedWatcher ||
    options.liveCompanion ||
    options.requiredTools?.length ||
    options.cliConfigArgs?.length ||
    options.contentBlocks?.some((block) => block.type !== 'text')
  )
    return;

  const model = options.executionPreferences?.model ?? scope.model;
  const readAccount = () => {
    const profile = resolveByAccountRef(projectRoot, account.accountRef);
    if (
      profile?.client !== 'anthropic' ||
      profile.authType !== 'api_key' ||
      profile.syntheticNative ||
      !profile.apiKey ||
      !profile.baseUrl ||
      validateRuntimeProviderBinding('anthropic', profile, model) ||
      claudeExecutionAccountSnapshot(profile).accountRevision !== account.accountRevision
    )
      throw new Error('Claude Code gateway account is unavailable or changed');
    const url = new URL(profile.baseUrl);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Claude Code gateway address is unavailable');
    return { apiKey: profile.apiKey, baseUrl: profile.baseUrl, loopback };
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
          throw new Error('Claude Code session request is outside the Host grant');
        const { baseUrl } = readAccount();
        const cwd = await realpath(scope.cwd);
        const home = join(
          resolveCatCafeDataRoot(),
          'claude-api-execution',
          createHash('sha256')
            .update(JSON.stringify([projectRoot, account.accountRevision, baseUrl, cwd]))
            .digest('hex'),
        );
        const fingerprint = createHash('sha256').update(scope.instructions).digest('hex');
        if (input.resumeNativeSessionId) {
          // Claude print retains the original system prompt on resume even if a new file is supplied.
          const saved = await readFile(join(home, 'identity-fingerprints', input.resumeNativeSessionId), 'utf8').catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return undefined;
              throw error;
            },
          );
          if (saved !== fingerprint) return {};
        }
        await mkdir(home, { recursive: true, mode: 0o700 });
        const dir = await mkdtemp(join(home, 'identity-'));
        const session = { dir, file: join(dir, 'system.txt'), home, cwd, projectRoot, fingerprint };
        try {
          await writeFile(session.file, scope.instructions, { mode: 0o600, flag: 'wx' });
          signal.throwIfAborted();
          request.activationSignal.throwIfAborted();
          sessions ??= activations.get(request.activationSignal);
          if (!sessions) {
            const owned = new Map<string, Session>();
            sessions = owned;
            activations.set(request.activationSignal, owned);
            request.activationSignal.addEventListener(
              'abort',
              () => {
                for (const prior of owned.values()) void cleanup(prior).catch(() => {});
                owned.clear();
              },
              { once: true },
            );
          }
          const prior = sessions.get(key);
          if (prior) void cleanup(prior).catch(() => {});
          sessions.set(key, session);
        } catch (error) {
          await cleanup(session);
          throw error;
        }
        return {
          agentFile: session.file,
          ...(input.resumeNativeSessionId ? { nativeSessionId: input.resumeNativeSessionId } : {}),
        };
      },
    };
  }

  const session = sessions?.get(key);
  if (
    !session ||
    session.projectRoot !== projectRoot ||
    (scope.nativeSessionId !== undefined && !nativeId.test(scope.nativeSessionId))
  )
    return;
  let launched = false;
  const run = createAgentAdapterNativeProcess(async ({ hostSessionId, args, stdin }) => {
    const expected = [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--system-prompt-file',
      session.file,
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      ...(scope.nativeSessionId ? ['--resume', scope.nativeSessionId] : []),
      ...(scope.model ? ['--model', scope.model] : []),
    ];
    if (
      launched ||
      hostSessionId !== scope.sessionId ||
      typeof stdin !== 'string' ||
      stdin !== scope.prompt ||
      args.length !== expected.length ||
      args.some((value, index) => value !== expected[index])
    )
      throw new Error('Claude Code process request is outside the Host grant');
    launched = true;
    if ((await realpath(scope.cwd)) !== session.cwd) throw new Error('Claude Code workspace changed');
    const command = resolveCliCommand('claude');
    if (!command) throw new Error('Claude Code executable is unavailable');
    const { baseUrl, apiKey, loopback } = readAccount();
    const newSessionId = scope.nativeSessionId ? undefined : randomUUID();
    await options.beforeProviderLaunch?.({
      v: 1,
      message: { body: stdin },
      nativeInstructions: [{ body: scope.instructions, injectionDecision: 'native_l0_compiled' }],
      runtime: {
        provider: 'anthropic',
        carrier: 'print_sdk',
        protocol: 'stream-json',
        ...(model ? { model } : {}),
      },
      tools: { finalSurface: 'unknown' },
      providerNativeVisibility: 'unknown',
    });
    return {
      command,
      cwd: session.cwd,
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? null,
        ComSpec: process.env.ComSpec ?? null,
        PATHEXT: process.env.PATHEXT ?? null,
        HOME: session.home,
        USERPROFILE: session.home,
        APPDATA: session.home,
        LOCALAPPDATA: session.home,
        TEMP: session.home,
        TMP: session.home,
        CLAUDE_CONFIG_DIR: session.home,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: apiKey,
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ...(loopback ? { NO_PROXY: '127.0.0.1,localhost,::1' } : {}),
      },
      args: [
        ...expected,
        ...(model && !scope.model ? ['--model', model] : []),
        ...(newSessionId ? ['--session-id', newSessionId] : []),
      ],
      stdinInput: stdin,
      invocationId: options.invocationId,
      async assertLaunchCurrent() {
        request.activationSignal.throwIfAborted();
        readAccount();
        if ((await realpath(scope.cwd)) !== session.cwd) throw new Error('Claude Code workspace changed');
        if (newSessionId) {
          const fingerprints = join(session.home, 'identity-fingerprints');
          await mkdir(fingerprints, { recursive: true, mode: 0o700 });
          await writeFile(join(fingerprints, newSessionId), session.fingerprint, { mode: 0o600, flag: 'wx' });
        }
      },
    };
  });
  return {
    run(input, signal) {
      return run(input, AbortSignal.any([signal, request.activationSignal]));
    },
  };
};
