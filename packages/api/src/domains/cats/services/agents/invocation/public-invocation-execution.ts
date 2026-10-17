import type { CatId } from '@cat-cafe/shared';
import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import type { AgentMessage, AgentService, AgentServiceOptions, ToolExecutionPolicy } from '../../types.js';

/** Host owns preparation and cleanup until prepare resolves, including cancellation during preparation. */
export interface PublicInvocationExecution {
  prepare(input: {
    readonly invocationId: string;
    readonly sourceMessageId: string;
    readonly signal: AbortSignal;
  }): Promise<{
    /** Host-selected prompt bound to the exact durable trigger. launch.assertCurrent
     * must fence these bytes, child identity and package authority. */
    readonly source: { readonly messageId: string; readonly content: string };
    readonly launch: NonNullable<AgentServiceOptions['pluginNativeLaunch']>;
    dispose(): void | Promise<void>;
  }>;
}

/** Capture the callable, not a mutable port slot, before child registration can await. */
export function capturePublicInvocationExecution(
  port: PublicInvocationExecution | undefined,
): PublicInvocationExecution | undefined {
  if (port === undefined) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(port, 'prepare');
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new Error('public_execution_port_invalid');
  }
  return Object.freeze({ prepare: descriptor.value.bind(port) });
}

/** One isolated plugin attempt. Public and Host-bound Task lanes share cleanup, never identity. */
export async function* executePublicInvocation(input: {
  readonly port: PublicInvocationExecution | undefined;
  readonly invocationId: string;
  readonly catId: CatId;
  readonly sourceMessageId: string;
  readonly service: AgentService;
  readonly policy: ToolExecutionPolicy | undefined;
  readonly signal: AbortSignal;
  readonly callbackEnv: Readonly<Record<string, string>>;
  readonly expose: () => Promise<void>;
  readonly close: (iterator: AsyncIterator<AgentMessage>) => Promise<boolean>;
}): AsyncGenerator<AgentMessage, boolean> {
  if (!input.port || input.policy?.mode !== 'plugin_native') throw new Error('public_execution_unavailable');
  const sourceMessageId = input.sourceMessageId;
  if (typeof sourceMessageId !== 'string' || !sourceMessageId.length)
    throw new Error('public_execution_source_invalid');
  input.signal.throwIfAborted();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  // prepare's contract owns partial allocations until it resolves. No caller-side
  // race may detach a pending preparation from that cleanup owner.
  const prepared = await input.port.prepare(
    Object.freeze({ invocationId: input.invocationId, sourceMessageId, signal }),
  );
  const dispose = prepared.dispose.bind(prepared);
  let iterator: AsyncIterator<AgentMessage> | undefined;
  let completed = false;
  try {
    const source = capturePublicSource(prepared.source, sourceMessageId);
    const original = prepared.launch;
    if (typeof original.assertCurrent !== 'function' || original.sandbox?.kind !== 'public') {
      throw new Error('public_execution_launch_invalid');
    }
    const check = original.assertCurrent.bind(original);
    const server = snapshotPluginProtocolData(original.server) as typeof original.server;
    const sandbox = snapshotPluginProtocolData(original.sandbox) as typeof original.sandbox;
    // A failed check permanently poisons this attempt, even if a provider swallows
    // its rejection and authority later returns. The same fence goes to the provider.
    const assertCurrent = async () => {
      try {
        signal.throwIfAborted();
        await check();
        signal.throwIfAborted();
      } catch (error) {
        lifetime.abort(error);
        throw error;
      }
    };
    await assertCurrent();
    await input.expose();
    await assertCurrent();
    const options: AgentServiceOptions = {
      signal,
      workingDirectory: sandbox.workspaceRoot,
      toolExecutionPolicy: input.policy,
      callbackEnv: { ...input.callbackEnv },
      pluginNativeLaunch: Object.freeze({ server, sandbox, assertCurrent }),
    };
    iterator = input.service.invoke(source.content, options)[Symbol.asyncIterator]();
    for (;;) {
      await assertCurrent();
      const next = await nextPublicEvent(iterator, signal);
      await assertCurrent();
      if (next.done) break;
      const message = next.value;
      if (message.catId !== input.catId) throw new Error('public_execution_foreign_event');
      if (message.type === 'error') throw new Error('public_execution_provider_failed');
      // Do not project provider-authored routing/session/freshness controls into
      // the ordinary consumer. Native tool execution stays inside the provider.
      if (message.type !== 'text' && message.type !== 'done') continue;
      yield {
        type: message.type,
        catId: input.catId,
        ...(message.type === 'text'
          ? { content: message.content, ...(message.textMode ? { textMode: message.textMode } : {}) }
          : {}),
        timestamp: message.timestamp,
        turnInvocationId: input.invocationId,
      };
      if (message.type === 'done') {
        await assertCurrent();
        completed = true;
        break;
      }
    }
  } finally {
    lifetime.abort(new Error('public_execution_closed'));
    try {
      if (iterator && !(await input.close(iterator))) throw new Error('public_execution_provider_close_timeout');
    } finally {
      await dispose();
    }
  }
  return completed;
}

function nextPublicEvent<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => iterator.next())
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Source provenance belongs to prepare, never to the generic route prompt. */
function capturePublicSource(
  value: unknown,
  messageId: string,
): { readonly messageId: string; readonly content: string } {
  let captured: unknown;
  try {
    captured = snapshotPluginProtocolData(value);
  } catch {
    throw new Error('public_execution_source_invalid');
  }
  if (!captured || typeof captured !== 'object' || Array.isArray(captured))
    throw new Error('public_execution_source_invalid');
  const row = captured as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || row.messageId !== messageId || typeof row.content !== 'string') {
    throw new Error('public_execution_source_invalid');
  }
  return captured as { readonly messageId: string; readonly content: string };
}
