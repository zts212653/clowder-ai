import type { AgentCarrierSession } from '../../types.js';

export function wrapReservedHostConnection(input: {
  connection: AgentCarrierSession;
  reusedSessionHost: boolean;
  abortObserved(): boolean;
  releaseLease(): boolean;
  releaseHost(): Promise<void>;
  terminateHost(): Promise<void>;
  rememberSession(sessionId: string): void;
}): AgentCarrierSession {
  let released = false;
  const releaseOnce = async (terminateHost: boolean): Promise<void> => {
    if (released) return;
    released = true;
    const mustTerminateHost = terminateHost || input.abortObserved();
    if (!input.releaseLease()) return;
    if (mustTerminateHost) await input.terminateHost();
    else await input.releaseHost();
  };
  return {
    read: () => input.connection.read(),
    write: (message) => input.connection.write(message),
    reusedSessionHost: input.reusedSessionHost,
    rememberSession: input.rememberSession,
    close: async () => {
      try {
        await input.connection.close();
        await releaseOnce(false);
      } catch (error) {
        await releaseOnce(true).catch(() => {});
        throw error;
      }
    },
    terminate: async () => {
      try {
        await (input.connection.terminate?.() ?? input.connection.close());
      } finally {
        await releaseOnce(true);
      }
    },
  };
}

export function wrapAttachedHostConnection(input: {
  connection: AgentCarrierSession;
  reusedSessionHost: boolean;
  releaseAttachment(): Promise<void>;
}): AgentCarrierSession {
  let released = false;
  const releaseOnce = async (terminate: boolean): Promise<void> => {
    if (released) return;
    released = true;
    try {
      if (terminate) {
        await (input.connection.terminate?.() ?? input.connection.close());
      } else {
        try {
          await input.connection.close();
        } catch (error) {
          await input.connection.terminate?.().catch(() => {});
          throw error;
        }
      }
    } finally {
      await input.releaseAttachment();
    }
  };
  return {
    read: () => input.connection.read(),
    write: (message) => input.connection.write(message),
    reusedSessionHost: input.reusedSessionHost,
    close: () => releaseOnce(false),
    terminate: () => releaseOnce(true),
  };
}
