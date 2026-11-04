import { createCatId } from '@cat-cafe/shared';
import { readDshNativeAccount } from '../../../../../../../config/native-accounts/dsh-account.js';
import type { DshNativeLaunch } from '../../../../../../../config/native-accounts/dsh-installation.js';
import type { AgentMessage, AgentServiceOptions, MessageMetadata } from '../../../../types.js';
import { providerProfileAccountSnapshot } from '../../../invocation/execution-account-binding.js';
import { captureScopedMemberLaunch } from '../../../invocation/scoped-member-launch.js';
import { compileL0ViaSubprocess } from '../../l0-compiler.js';
import { AcpClient } from '../AcpClient.js';
import { createAcpSessionState, flushAcpThinking, transformAcpEvent } from '../acp-event-transformer.js';
import { prepareDshMemberLaunch } from './dsh-member-launch.js';

/** One bounded member turn over the existing ACP transport. Native sessions
 * are fresh; only Host-granted memory and the game's own diary continue. */
export async function* invokeDshMember(input: {
  readonly catId: string;
  readonly modelSelection: string;
  readonly native: DshNativeLaunch;
  readonly prompt: string;
  readonly options?: AgentServiceOptions;
  readonly compile?: typeof compileL0ViaSubprocess;
}): AsyncGenerator<AgentMessage> {
  const catId = createCatId(input.catId),
    options = input.options,
    signal = options?.signal;
  let client: AcpClient | undefined, dispose: (() => Promise<void>) | undefined, removeAbort: (() => void) | undefined;
  let errorCode: string | undefined;
  let metadata: MessageMetadata = { provider: 'acp', model: input.modelSelection };
  try {
    if (
      !options?.pluginNativeLaunch ||
      !options.executionAccount ||
      !signal ||
      options.spawnCliOverride ||
      options.agentCarrierSessionFactory ||
      options.requiredTools?.length ||
      options.cliConfigArgs?.length ||
      Object.keys(options.accountEnv ?? {}).length
    )
      throw new Error('dsh_member_launch_required');
    const member = captureScopedMemberLaunch(
      { ...options, scopedMemberLaunch: options.pluginNativeLaunch },
      options.workingDirectory,
    );
    if (!member || !options.workingDirectory || member.server.transport !== 'stdio')
      throw new Error('dsh_member_launch_required');
    const executionAccount = Object.freeze(structuredClone(options.executionAccount));
    const callbackEnv = Object.freeze({ ...options.callbackEnv });
    const workingDirectory = options.workingDirectory,
      userId = callbackEnv.CAT_CAFE_USER_ID,
      beforeProviderLaunch = options.beforeProviderLaunch;
    const current = async () => {
      signal.throwIfAborted();
      await member.assertCurrent();
    };
    await current();
    const account = await readDshNativeAccount(input.native, input.modelSelection, workingDirectory);
    const frozen = providerProfileAccountSnapshot('acp', account.profile);
    if (
      frozen.accountRef !== executionAccount.accountRef ||
      frozen.authType !== executionAccount.authType ||
      frozen.accountRevision !== executionAccount.accountRevision
    )
      throw new Error('dsh_member_account_changed');
    metadata = { ...metadata, model: account.model, executionAccount };
    const identity = await (input.compile ?? compileL0ViaSubprocess)({
      catId: input.catId,
      userId,
      projection: 'scoped-member',
      runtimeModel: account.model,
      frozenInput: options.frozenL0Input,
      requireFrozenInput: true,
    });
    await current();
    const launch = await prepareDshMemberLaunch({ native: input.native, account, identity, member, callbackEnv });
    dispose = launch.dispose;
    await current();
    client = new AcpClient({ ...launch, inheritParentEnv: false, defaultPermissionDecision: 'reject' });
    const activeClient = client;
    const abort = () => {
      void activeClient.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    removeAbort = () => signal.removeEventListener('abort', abort);
    await client.initialize();
    await current();
    const session = await client.newSession(launch.cwd, []);
    await current();
    yield {
      type: 'session_init',
      catId,
      sessionId: session.sessionId,
      ephemeralSession: true,
      metadata,
      timestamp: Date.now(),
    };
    await current();
    await beforeProviderLaunch?.({
      v: 1,
      message: { body: input.prompt },
      nativeInstructions: [{ body: identity, injectionDecision: 'dsh_scoped_native_system' }],
      runtime: { provider: 'acp', carrier: 'acp', model: account.model, protocol: 'acp' },
      tools: { finalSurface: 'unknown' },
      providerNativeVisibility: 'unknown',
    });
    await current();
    const state = createAcpSessionState(),
      stream = client.promptStream(session.sessionId, input.prompt, { idleStallMs: 0, timeoutMs: 0 });
    try {
      while (true) {
        const next = await stream.next();
        if (next.done) {
          if (next.value !== 'end_turn') throw new Error('dsh_member_prompt_incomplete');
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
    errorCode = signal?.aborted ? 'aborted' : 'dsh_member_execution_failed';
    yield { type: 'error', catId, errorCode, error: errorCode, metadata, timestamp: Date.now() };
  } finally {
    removeAbort?.();
    try {
      await client?.close();
    } finally {
      await dispose?.();
    }
  }
  yield { type: 'done', catId, ...(errorCode ? { errorCode } : {}), metadata, timestamp: Date.now() };
}
