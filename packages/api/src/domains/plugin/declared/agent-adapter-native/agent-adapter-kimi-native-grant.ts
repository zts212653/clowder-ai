import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { normalizeKimiEvent } from '@clowder-ai/agent-access/runtime/kimi-event-parser';
import { buildKimiLaunchArguments } from '@clowder-ai/agent-access/runtime/kimi-launch-arguments';
import { resolveByAccountRef, validateRuntimeProviderBinding } from '../../../../config/account-resolver.js';
import { resolveCatCafeDataRoot } from '../../../../utils/cli-process-ownership.js';
import { resolveCliCommand } from '../../../../utils/cli-resolve.js';
import { providerProfileAccountSnapshot } from '../../../cats/services/agents/invocation/execution-account-binding.js';
import { buildApiKeyEnv } from '../../../cats/services/agents/providers/kimi-config.js';
import {
  computeKimiL0Fingerprint,
  lookupKimiL0Fingerprint,
  recordKimiL0Fingerprint,
} from '../../../cats/services/agents/providers/kimi-l0-session-fingerprint.js';
import type { AgentAdapterRuntimeGrant } from '../agent-adapter-access.js';
import { createAgentAdapterNativeProcess } from './agent-adapter-native-process.js';

const nativeId = /^(?:session_)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const privateConfig = [
  'auto_session_title = false',
  'merge_all_available_skills = false',
  'builtin_product_skills = false',
  'telemetry = false',
  '',
].join('\n');

type Session = {
  home: string;
  cwd: string;
  accountRevision: string;
  projectRoot: string;
  fingerprint: string;
  agentFile?: string;
};
const activations = new WeakMap<AbortSignal, Map<string, Session>>();

function cleanup(session: Session) {
  if (!session.agentFile) return;
  const identityDir = dirname(session.agentFile);
  if (dirname(identityDir) === session.home)
    void rm(identityDir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
}

/** Private, tool-free Kimi print for a catalog adapter and an explicitly bound API-key account. */
export const grantAgentAdapterKimiPrint: AgentAdapterRuntimeGrant = (request) => {
  const scope = request.hostSession;
  const catId = request.catId;
  if (!scope || !catId || request.activationSignal.aborted) return;
  const key = JSON.stringify([catId, scope.sessionId]);
  let sessions = activations.get(request.activationSignal);
  if (request.action === 'release') {
    const prior = sessions?.get(key);
    sessions?.delete(key);
    if (prior) cleanup(prior);
    return;
  }
  if (request.action !== 'openSession' && request.action !== 'startTurn') return;

  const options = scope.hostOptions;
  const account = scope.executionAccount;
  const projectRoot = options?.executionAccountProjectRoot;
  const model = (options?.executionPreferences?.model ?? scope.model)?.trim();
  if (
    !options ||
    !projectRoot ||
    !isAbsolute(projectRoot) ||
    !isAbsolute(scope.cwd) ||
    !model ||
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

  const readAccount = () => {
    const profile = resolveByAccountRef(projectRoot, account.accountRef);
    if (
      profile?.client !== 'kimi' ||
      profile.authType !== 'api_key' ||
      profile.syntheticNative ||
      !profile.apiKey ||
      !profile.baseUrl ||
      validateRuntimeProviderBinding('kimi', profile, model) ||
      // Explicit adapter members commonly persist as ACP. Existing Kimi members can retain their native client ID.
      !(['acp', 'kimi'] as const).some(
        (provider) => providerProfileAccountSnapshot(provider, profile).accountRevision === account.accountRevision,
      )
    )
      throw new Error('Kimi gateway account is unavailable or changed');
    const url = new URL(profile.baseUrl);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Kimi gateway address is unavailable');
    return { apiKey: profile.apiKey, baseUrl: profile.baseUrl, loopback };
  };

  if (request.action === 'openSession') {
    return {
      async prepare(input, signal) {
        signal.throwIfAborted();
        request.activationSignal.throwIfAborted();
        const resume = input.resumeNativeSessionId;
        if (
          input.hostSessionId !== scope.sessionId ||
          input.instructions !== scope.instructions ||
          resume !== scope.resumeNativeSessionId ||
          (resume !== undefined && !nativeId.test(resume))
        )
          throw new Error('Kimi session request is outside the Host grant');
        readAccount();
        const cwd = await realpath(scope.cwd);
        const home = join(
          resolveCatCafeDataRoot(),
          'kimi-api-execution',
          createHash('sha256')
            .update(JSON.stringify([projectRoot, account.accountRevision, cwd, catId]))
            .digest('hex'),
        );
        const fingerprint = computeKimiL0Fingerprint(scope.instructions);
        const saved = resume ? lookupKimiL0Fingerprint(home, catId, resume) : undefined;
        if (resume && saved !== fingerprint)
          return { nativeSessionId: resume, ...(saved === undefined ? {} : { sessionFingerprint: saved }) };

        const session: Session = { home, cwd, projectRoot, accountRevision: account.accountRevision, fingerprint };
        if (!resume) {
          await mkdir(join(home, 'skills'), { recursive: true, mode: 0o700 });
          await writeFile(join(home, 'config.toml'), privateConfig, { mode: 0o600 });
          await writeFile(join(home, 'mcp.json'), '{"mcpServers":{}}', { mode: 0o600 });
          session.agentFile = join(await mkdtemp(join(home, 'identity-')), 'agent.md');
        }
        try {
          if (session.agentFile) {
            const name = catId.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'cat';
            const identity = [
              '---',
              'name: cat-cafe-l0-' + name,
              'description: Managed member identity',
              'tools: []',
              'subagents: []',
              '---',
              '',
              scope.instructions,
              '',
            ].join('\n');
            await writeFile(session.agentFile, identity, { mode: 0o600, flag: 'wx' });
          }
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
                for (const prior of owned.values()) cleanup(prior);
                owned.clear();
              },
              { once: true },
            );
          }
          const prior = sessions.get(key);
          if (prior) cleanup(prior);
          sessions.set(key, session);
        } catch (error) {
          cleanup(session);
          throw error;
        }
        return resume ? { nativeSessionId: resume, sessionFingerprint: saved } : { agentFile: session.agentFile };
      },
    };
  }

  const session = sessions?.get(key);
  const prompt = scope.prompt;
  const resume = scope.nativeSessionId;
  if (
    !session ||
    session.projectRoot !== projectRoot ||
    session.accountRevision !== account.accountRevision ||
    prompt === undefined ||
    (resume ? !nativeId.test(resume) : !session.agentFile)
  )
    return;

  let launched = false;
  const run = createAgentAdapterNativeProcess(async ({ hostSessionId, args, stdin }) => {
    const launch = {
      prompt,
      model: scope.model,
      imageAccessDirs: [],
      resumeSessionId: resume,
      agentFile: resume ? undefined : session.agentFile,
    };
    const expected = buildKimiLaunchArguments(launch).args;
    if (
      launched ||
      hostSessionId !== scope.sessionId ||
      stdin !== undefined ||
      args.length !== expected.length ||
      args.some((value, index) => value !== expected[index])
    )
      throw new Error('Kimi process request is outside the Host grant');
    launched = true;
    const command = resolveCliCommand('kimi');
    if (!command) throw new Error('Kimi executable is unavailable');
    const { baseUrl, apiKey, loopback } = readAccount();
    await options.beforeProviderLaunch?.({
      v: 1,
      message: { body: prompt },
      nativeInstructions: resume ? [] : [{ body: scope.instructions, injectionDecision: 'native_agent_file_compiled' }],
      runtime: { provider: 'kimi', carrier: 'stream_json', protocol: 'stream-json', model },
      tools: { finalSurface: 'unknown' },
      providerNativeVisibility: 'unknown',
    });
    const home = session.home;
    return {
      command,
      cwd: session.cwd,
      args: buildKimiLaunchArguments({ ...launch, skillsDirectory: join(home, 'skills') }).args,
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? null,
        ComSpec: process.env.ComSpec ?? null,
        PATHEXT: process.env.PATHEXT ?? null,
        HOME: home,
        USERPROFILE: home,
        APPDATA: home,
        LOCALAPPDATA: home,
        TEMP: home,
        TMP: home,
        KIMI_CODE_HOME: home,
        KIMI_CODE_EXPERIMENTAL_FLAG: '1',
        KIMI_CODE_BUILTIN_PRODUCT_SKILLS: '0',
        KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: '0',
        KIMI_DISABLE_TELEMETRY: '1',
        ...(loopback ? { NO_PROXY: '127.0.0.1,localhost' } : {}),
        ...buildApiKeyEnv(model, { CAT_CAFE_KIMI_API_KEY: apiKey, CAT_CAFE_KIMI_BASE_URL: baseUrl }),
      },
      invocationId: options.invocationId,
      async assertLaunchCurrent() {
        request.activationSignal.throwIfAborted();
        readAccount();
        if ((await realpath(scope.cwd)) !== session.cwd) throw new Error('Kimi workspace changed');
      },
    };
  });

  return {
    async run(input, signal) {
      const stream = await run(input, AbortSignal.any([signal, request.activationSignal]));
      return (async function* () {
        let observed = resume;
        for await (const frame of stream) {
          if (!observed && frame.kind === 'record') {
            const event = normalizeKimiEvent(frame.value);
            if (event.kind !== 'ignored' && event.sessionId && nativeId.test(event.sessionId)) {
              observed = event.sessionId;
              recordKimiL0Fingerprint(session.home, catId, observed, session.fingerprint);
            }
          }
          yield frame;
        }
      })();
    },
  };
};
