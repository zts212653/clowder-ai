import type { GatewayMcpServer } from '@cat-cafe/mcp-server/dist/member-gateway.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { SharedMcpFactory } from '../declared/shared-mcp-factory.js';
import type { ModuleExecutionLease, ModuleExecutionWorker } from './client.js';

interface RemoteServer {
  connect(host: unknown): Promise<void>;
  message(...args: readonly unknown[]): Promise<void>;
  error(error: Error): Promise<void>;
  closed(): Promise<void>;
  close(): Promise<void>;
}

/** Bridge transport frames, not the server object or its internal request tables. */
export function executionMcpFactory(input: {
  readonly worker: ModuleExecutionWorker;
  readonly instanceId: string;
  readonly entrypoint: string;
  readonly exportName: string;
  readonly assertCurrent: () => void;
  readonly scopes: Set<() => Promise<void>>;
}): SharedMcpFactory {
  return (client): GatewayMcpServer => {
    input.assertCurrent();
    let lease: ModuleExecutionLease | undefined;
    let remote: RemoteServer | undefined;
    let transport: Transport | undefined;
    let closing: Promise<void> | undefined;
    let connecting: Promise<void> | undefined;
    let closed = false;
    let serverStopped = false;
    let transportStopped = false;
    const stopServer = async () => {
      if (!remote || serverStopped || lease?.exited) return;
      await remote.close();
      serverStopped = true;
    };
    const stopTransport = async () => {
      if (!transport || transportStopped) return;
      await transport.close();
      transportStopped = true;
    };
    const close = (): Promise<void> => {
      if (closed) return Promise.resolve();
      closing ??= (async () => {
        await connecting?.catch(() => undefined);
        const errors: unknown[] = [];
        for (const stop of [stopServer, stopTransport]) {
          try {
            await stop();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Shared MCP cleanup failed');
        await lease?.close();
        input.scopes.delete(close);
        closed = true;
      })().finally(() => {
        closing = undefined;
      });
      return closing;
    };
    const assertConnecting = () => {
      input.assertCurrent();
      if (closed || closing) throw new Error('Shared MCP connection has closed');
    };
    const initialize = async (actual: Transport) => {
      lease = await input.worker.lease(input.instanceId);
      assertConnecting();
      remote = await lease.call<RemoteServer>('factory', input.entrypoint, input.exportName, lease.retain(client));
      assertConnecting();
      const server = remote;
      actual.onmessage = (...args) => {
        void server.message(...args).catch((error) => actual.onerror?.(error));
      };
      actual.onerror = (error) => {
        void server
          .error(error)
          .catch(() => close())
          .catch(() => undefined);
      };
      actual.onclose = () => {
        void server
          .closed()
          .then(close, close)
          .catch(() => undefined);
      };
      await server.connect(
        lease.retain({
          start: () => actual.start(),
          send: (...args: Parameters<Transport['send']>) => actual.send(...args),
          close: () => actual.close(),
          readSessionId: () => actual.sessionId,
          ...(actual.setProtocolVersion
            ? { setProtocolVersion: (version: string) => actual.setProtocolVersion?.(version) }
            : {}),
        }),
      );
      assertConnecting();
    };
    return {
      async connect(actual) {
        assertConnecting();
        if (connecting) throw new Error('Shared MCP connection has already started');
        transport = actual;
        input.scopes.add(close);
        connecting = initialize(actual);
        try {
          await connecting;
        } catch (error) {
          await close();
          throw error;
        }
      },
      close,
    };
  };
}
