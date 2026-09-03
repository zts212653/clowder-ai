import { createServer, type Server } from 'node:http';

import { createCollectiveHttpHandler } from './http-router.js';
import type { CollectiveServiceStore } from './store.js';

export interface StartCollectiveServerOptions {
  readonly store: CollectiveServiceStore;
  readonly host?: string;
  readonly port?: number;
  readonly allowedHostOrigins?: readonly string[];
  readonly bootstrapLinkPath?: string;
}

export interface RunningCollectiveServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

const RESERVED_RUNTIME_PORTS = new Set([3001, 3002]);

export async function startCollectiveServer(options: StartCollectiveServerOptions): Promise<RunningCollectiveServer> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 5201;
  if (RESERVED_RUNTIME_PORTS.has(requestedPort)) {
    throw new Error(`Port ${requestedPort} is reserved for the Clowder AI runtime`);
  }
  const handler = createCollectiveHttpHandler({
    store: options.store,
    allowedHostOrigins: options.allowedHostOrigins ?? [],
    bootstrapLinkPath: options.bootstrapLinkPath,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Collective Service did not bind a TCP address');
  }
  const url = `http://${host}:${address.port}`;
  return {
    host,
    port: address.port,
    url,
    server,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
