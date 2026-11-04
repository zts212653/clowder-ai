import { watch } from 'node:fs';
import { createCatId } from '@cat-cafe/shared';
import { readKimiNativeAccount } from '../../../../../../../config/native-accounts/kimi-account.js';
import type { KimiNativeLaunch } from '../../../../../../../config/native-accounts/kimi-installation.js';
import type { AgentMessage, AgentServiceOptions, MessageMetadata } from '../../../../types.js';
import { providerProfileAccountSnapshot } from '../../../invocation/execution-account-binding.js';
import { captureScopedMemberLaunch } from '../../../invocation/scoped-member-launch.js';
import { compileL0ViaSubprocess } from '../../l0-compiler.js';
import { AcpClient } from '../AcpClient.js';
import { createAcpSessionState, flushAcpThinking, transformAcpEvent } from '../acp-event-transformer.js';
import { prepareKimiMemberLaunch } from './kimi-member-launch.js';

/** Fresh native ACP turn, original native OAuth and existing Host experience stores. */
export async function* invokeKimiMember(input: {
  readonly catId: string;
  readonly modelSelection: string;
  readonly native: KimiNativeLaunch;
  readonly prompt: string;
  readonly options?: AgentServiceOptions;
  readonly compile?: typeof compileL0ViaSubprocess;
}): AsyncGenerator<AgentMessage> {
  const catId = createCatId(input.catId),
    options = input.options,
    signal = options?.signal;
  let client: AcpClient | undefined, dispose: (() => Promise<void>) | undefined;
  let removeAbort: (() => void) | undefined, stopWatching: (() => void) | undefined;
  let sessionId: string | undefined;
  let changed = false,
    errorCode: string | undefined;
  let metadata: MessageMetadata = { provider: 'kimi', model: input.modelSelection };
  try {
    if (
      !options?.pluginNativeLaunch ||
      !signal ||
      !options.executionAccount ||
      options.executionAccount.authType !== 'oauth' ||
      options.spawnCliOverride ||
      options.agentCarrierSessionFactory ||
      options.requiredTools?.length ||
      options.cliConfigArgs?.length
    )
      throw new Error('kimi_member_launch_required');
    const member = captureScopedMemberLaunch(
      { ...options, scopedMemberLaunch: options.pluginNativeLaunch },
      options.workingDirectory,
    );
    if (!member || !options.workingDirectory) throw new Error('kimi_member_launch_required');
    const executionAccount = Object.freeze(structuredClone(options.executionAccount));
    const callbackEnv = Object.freeze({ ...options.callbackEnv });
    const beforeProviderLaunch = options.beforeProviderLaunch,
      userId = callbackEnv.CAT_CAFE_USER_ID;
    const account = await readKimiNativeAccount(input.native, input.modelSelection, executionAccount.accountRef);
    const assertSource = async () => {
      signal.throwIfAborted();
      if (changed) throw new Error('kimi_member_account_changed');
      await member.assertCurrent();
      const current = await readKimiNativeAccount(input.native, input.modelSelection, executionAccount.accountRef);
      const frozen = providerProfileAccountSnapshot('kimi', current.profile);
      if (
        frozen.accountRef !== executionAccount.accountRef ||
        frozen.authType !== executionAccount.authType ||
        frozen.accountRevision !== executionAccount.accountRevision
      )
        throw new Error('kimi_member_account_changed');
    };
    await assertSource();
    if (Object.entries(options.accountEnv ?? {}).some(([key, value]) => account.accountEnv[key] !== value))
      throw new Error('kimi_member_account_env_changed');
    const closeOnChange = () => {
      changed = true;
      if (sessionId) client?.cancelSession(sessionId);
      void client?.close().catch(() => {});
    };
    const watcher = watch(account.home, (_event, filename) => {
      if (filename !== null && !['config.toml', 'mcp.json'].includes(String(filename))) return;
      closeOnChange();
    });
    watcher.on('error', closeOnChange);
    stopWatching = () => watcher.close();
    const identity = await (input.compile ?? compileL0ViaSubprocess)({
      catId: input.catId,
      userId,
      projection: 'scoped-member',
      runtimeModel: account.model,
      frozenInput: options.frozenL0Input,
      requireFrozenInput: true,
    });
    await assertSource();
    const launch = await prepareKimiMemberLaunch({ native: input.native, account, identity, member, callbackEnv });
    dispose = launch.dispose;
    await assertSource();
    client = new AcpClient({
      ...launch,
      inheritParentEnv: false,
      defaultPermissionDecision: 'reject',
      permissionHandler: async (request, respond) => {
        try {
          await assertSource();
          const params = request.params as {
            toolCall?: { title?: unknown };
            options?: { kind: string; optionId: string }[];
          };
          const title = params.toolCall?.title;
          const option =
            typeof title === 'string' && title.startsWith(`mcp__${launch.serverName}__`)
              ? params.options?.find((item) => item.kind === 'allow_once')
              : undefined;
          respond(option ? { optionId: option.optionId } : { cancelled: true });
        } catch {
          closeOnChange();
          respond({ cancelled: true });
        }
      },
    });
    const active = client,
      abort = () => {
        if (sessionId) active.cancelSession(sessionId);
        void active.close().catch(() => {});
      };
    signal.addEventListener('abort', abort, { once: true });
    removeAbort = () => signal.removeEventListener('abort', abort);
    await client.initialize();
    await assertSource();
    const session = await client.newSession(launch.cwd, []);
    sessionId = session.sessionId;
    await assertSource();
    await client.setSessionModel(session.sessionId, account.modelAlias);
    await assertSource();
    metadata = { ...metadata, model: account.model, executionAccount };
    yield {
      type: 'session_init',
      catId,
      sessionId: session.sessionId,
      ephemeralSession: true,
      metadata,
      timestamp: Date.now(),
    };
    await assertSource();
    await beforeProviderLaunch?.({
      v: 1,
      message: { body: input.prompt },
      nativeInstructions: [{ body: identity, injectionDecision: 'kimi_scoped_native_system' }],
      runtime: { provider: 'kimi', carrier: 'acp', model: account.model, protocol: 'acp' },
      tools: { finalSurface: 'unknown' },
      providerNativeVisibility: 'unknown',
    });
    await assertSource();
    const state = createAcpSessionState();
    const stream = client.promptStream(session.sessionId, input.prompt, { idleStallMs: 0, timeoutMs: 0 });
    try {
      while (true) {
        const next = await stream.next();
        if (next.done) {
          if (next.value !== 'end_turn') throw new Error('kimi_member_prompt_incomplete');
          break;
        }
        const transformed = transformAcpEvent(next.value, catId, metadata, state);
        if (Array.isArray(transformed)) yield* transformed;
        else if (transformed) yield transformed;
      }
      const thinking = flushAcpThinking(state, catId, metadata);
      if (thinking) yield thinking;
    } finally {
      await stream.return('cancelled');
    }
  } catch {
    errorCode = signal?.aborted ? 'aborted' : 'kimi_member_execution_failed';
    yield { type: 'error', catId, errorCode, error: errorCode, metadata, timestamp: Date.now() };
  } finally {
    removeAbort?.();
    stopWatching?.();
    try {
      await client?.close();
    } finally {
      await dispose?.();
    }
  }
  yield { type: 'done', catId, ...(errorCode ? { errorCode } : {}), metadata, timestamp: Date.now() };
}
