import { addAbortListener } from 'node:events';
import type { AgentAdapterNativeRuntime } from '@clowder-ai/agent-contract';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import { type AcpClient, AcpProtocolError } from '../../../cats/services/agents/providers/acp/AcpClient.js';

const log = createModuleLogger('plugin/agent-adapter-acp');

type AcpRuntime = NonNullable<AgentAdapterNativeRuntime['acp']>;
type NativeClient = Pick<
  AcpClient,
  | 'newSession'
  | 'resumeSession'
  | 'promptStream'
  | 'hasPromptFinalResponse'
  | 'isSafeForSingleFlightReuse'
  | 'agentCapabilities'
  | 'pid'
  | 'cancelSession'
  | 'closeSession'
  | 'close'
>;

/** The launch grant initializes a client using the selected account, cwd and validated startup files. */
export function createAgentAdapterAcpRuntime(
  createClient: (
    input: Parameters<AcpRuntime['open']>[0],
    signal: AbortSignal,
  ) => Promise<{ client: NativeClient; cwd: string }>,
  activation: AbortSignal,
): AcpRuntime {
  const sessions = new Map<
    string,
    { client: NativeClient; nativeId: string; startup: Parameters<AcpRuntime['open']>[0]['startup'] }
  >();
  const release = async (hostSessionId: string) => {
    const session = sessions.get(hostSessionId);
    if (!session) return;
    sessions.delete(hostSessionId);
    try {
      await session.client.closeSession(session.nativeId);
    } finally {
      await session.client.close();
    }
  };
  addAbortListener(activation, () => {
    const previous = [...sessions.values()];
    sessions.clear();
    void Promise.allSettled(previous.map(({ client }) => client.close()));
  });
  const open: AcpRuntime['open'] = async (input, signal) => {
    const scope = AbortSignal.any([activation, signal]);
    scope.throwIfAborted();
    if (sessions.has(input.hostSessionId)) return { ok: false, code: 'failed' };
    const { client, cwd } = await createClient(input, scope);
    const close = addAbortListener(scope, () => {
      void client.close().catch(() => {});
    });
    let opened = false;
    try {
      scope.throwIfAborted();
      const native = input.resumeNativeSessionId
        ? await client.resumeSession(input.resumeNativeSessionId, cwd, [])
        : await client.newSession(cwd, []);
      scope.throwIfAborted();
      if (!native.sessionId || (input.resumeNativeSessionId && native.sessionId !== input.resumeNativeSessionId))
        return { ok: false, code: input.resumeNativeSessionId ? 'resume_unavailable' : 'failed' };
      sessions.set(input.hostSessionId, { client, nativeId: native.sessionId, startup: input.startup });
      opened = true;
      return { ok: true, nativeSessionId: native.sessionId };
    } catch (error) {
      scope.throwIfAborted();
      if (input.resumeNativeSessionId && error instanceof AcpProtocolError)
        return { ok: false, code: 'resume_unavailable' };
      throw error;
    } finally {
      close[Symbol.dispose]();
      if (!opened) await client.close();
    }
  };
  return {
    open,
    async prompt(input, signal) {
      const { hostSessionId } = input;
      const scope = AbortSignal.any([activation, signal]);
      return (async function* () {
        scope.throwIfAborted();
        let session = sessions.get(hostSessionId);
        if (session && !session.client.isSafeForSingleFlightReuse) {
          // ACP updates carry only the session ID. A cancelled prompt can still emit on this client.
          const { client, startup, nativeId } = session;
          if (client.agentCapabilities?.sessionCapabilities?.close) {
            await client.closeSession(nativeId);
            sessions.delete(hostSessionId);
            // The native close was acknowledged. Its disconnected process can finish exiting independently.
            void client.close().catch((err) => log.warn({ err, pid: client.pid }, 'ACP process exit not confirmed'));
          } else {
            await release(hostSessionId);
          }
          await open({ hostSessionId, startup, resumeNativeSessionId: nativeId }, scope);
          session = sessions.get(hostSessionId);
        }
        if (!session) throw new Error('Native ACP session is unavailable');
        const { client, nativeId } = session;
        const stream = client.promptStream(nativeId, input.prompt);
        const abort = addAbortListener(scope, () => client.cancelSession(nativeId, true));
        try {
          while (true) {
            const next = await stream.next();
            if (next.done) {
              yield {
                kind: 'terminal' as const,
                stopReason: next.value,
                finalResponse: client.hasPromptFinalResponse(nativeId),
              };
              return;
            }
            yield { kind: 'update' as const, update: next.value };
          }
        } finally {
          abort[Symbol.dispose]();
          if (!client.hasPromptFinalResponse(nativeId)) client.cancelSession(nativeId, true);
          await stream.return('cancelled');
        }
      })();
    },
    async cancel(hostSessionId) {
      const session = sessions.get(hostSessionId);
      return session?.client.cancelSession(session.nativeId, true) ?? false;
    },
    release,
  };
}
