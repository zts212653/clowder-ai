import { createCatId } from '@cat-cafe/shared';
import { readDshNativeAccount } from '../../../../../../../config/native-accounts/dsh-account.js';
import type { DshNativeLaunch } from '../../../../../../../config/native-accounts/dsh-installation.js';
import type { AgentMessage, AgentServiceOptions, MessageMetadata } from '../../../../types.js';
import { providerProfileAccountSnapshot } from '../../../invocation/execution-account-binding.js';
import { compileL0ViaSubprocess } from '../../l0-compiler.js';
import { captureWatcherOptions } from '../../watcher-invocation-options.js';
import { AcpClient } from '../AcpClient.js';
import { createAcpSessionState, flushAcpThinking, transformAcpEvent } from '../acp-event-transformer.js';
import { prepareDshWatcherLaunch } from './dsh-watcher-launch.js';

/** Ordinary native context, its existing account, and loadable watcher history; never the worker process pool. */
export async function* invokeDshWatcher(input: {
  catId: string;
  modelSelection: string;
  native: DshNativeLaunch;
  prompt: string;
  options?: AgentServiceOptions;
  compile?: typeof compileL0ViaSubprocess;
}): AsyncGenerator<AgentMessage> {
  const catId = createCatId(input.catId);
  let client: AcpClient | undefined, dispose: (() => Promise<void>) | undefined, abort: (() => void) | undefined;
  let errorCode: string | undefined;
  let metadata: MessageMetadata = { provider: 'acp', model: input.modelSelection };
  try {
    const options = captureWatcherOptions(input.options);
    if (
      !options?.signal ||
      !options.executionAccount ||
      !options.workingDirectory ||
      !options.hostSessionId ||
      options.spawnCliOverride ||
      options.agentCarrierSessionFactory ||
      Object.keys(options.accountEnv ?? {}).length
    )
      throw new Error('dsh_watcher_launch_required');
    options.signal.throwIfAborted();
    const account = await readDshNativeAccount(input.native, input.modelSelection, options.workingDirectory);
    const snapshot = providerProfileAccountSnapshot('acp', account.profile);
    if (
      snapshot.accountRef !== options.executionAccount.accountRef ||
      snapshot.accountRevision !== options.executionAccount.accountRevision
    )
      throw new Error('dsh_watcher_account_changed');
    metadata = { ...metadata, model: account.model, executionAccount: snapshot };
    const identity = await (input.compile ?? compileL0ViaSubprocess)({
      catId: input.catId,
      userId: options.callbackEnv?.CAT_CAFE_USER_ID,
      runtimeModel: account.model,
      frozenInput: options.frozenL0Input,
      requireFrozenInput: true,
    });
    options.signal.throwIfAborted();
    const launch = await prepareDshWatcherLaunch({ native: input.native, account, identity, options });
    dispose = launch.dispose;
    client = new AcpClient({ ...launch, inheritParentEnv: false, defaultPermissionDecision: 'reject' });
    const active = client;
    abort = () => {
      void active.close();
    };
    options.signal.addEventListener('abort', abort, { once: true });
    await client.initialize();
    options.signal.throwIfAborted();
    const session = options.sessionId
      ? await client.loadSession(options.sessionId, launch.cwd)
      : await client.newSession(launch.cwd, []);
    if (options.sessionId && session.sessionId !== options.sessionId)
      throw new Error('dsh_watcher_native_session_replaced');
    yield { type: 'session_init', catId, sessionId: session.sessionId, metadata, timestamp: Date.now() };
    await options.beforeProviderLaunch?.({
      v: 1,
      message: { body: input.prompt },
      nativeInstructions: [{ body: identity, injectionDecision: 'dsh_watcher_system' }],
      runtime: { provider: 'acp', carrier: 'acp', model: account.model, protocol: 'acp' },
      tools: { finalSurface: 'unknown' },
      providerNativeVisibility: 'unknown',
    });
    options.signal.throwIfAborted();
    const state = createAcpSessionState();
    const stream = client.promptStream(session.sessionId, input.prompt, { idleStallMs: 0, timeoutMs: 0 });
    try {
      while (true) {
        const next = await stream.next();
        if (next.done) {
          if (next.value !== 'end_turn') throw new Error('dsh_watcher_prompt_incomplete');
          break;
        }
        const event = transformAcpEvent(next.value, catId, metadata, state);
        if (Array.isArray(event)) yield* event;
        else if (event) yield event;
      }
      const thinking = flushAcpThinking(state, catId, metadata);
      if (thinking) yield thinking;
    } finally {
      await stream.return('cancelled');
    }
  } catch (error) {
    errorCode = input.options?.signal?.aborted ? 'aborted' : 'dsh_watcher_execution_failed';
    yield {
      type: 'error',
      catId,
      errorCode,
      error:
        error instanceof Error && /session.*(?:not found|missing)/i.test(error.message)
          ? 'native session not found'
          : errorCode,
      metadata,
      timestamp: Date.now(),
    };
  } finally {
    if (abort) input.options?.signal?.removeEventListener('abort', abort);
    try {
      await client?.close();
    } finally {
      await dispose?.();
    }
  }
  yield { type: 'done', catId, ...(errorCode ? { errorCode } : {}), metadata, timestamp: Date.now() };
}
