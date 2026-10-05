import { createServer } from 'node:net';

/** Reserve both neighboring ports before the Service or Chromium can allocate either one. */
export async function reserveNativeOwnerPorts() {
  const close = (server) => (server.listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve());
  const listen = (server, port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  for (let attempt = 0; attempt < 10; attempt++) {
    const host = createServer();
    const api = createServer();
    await listen(host, 0);
    const hostPort = host.address().port;
    try {
      await listen(api, hostPort + 1);
      return {
        hostPort,
        apiPort: hostPort + 1,
        releaseHost: () => close(host),
        releaseApi: () => close(api),
        close: async () => {
          await close(host);
          await close(api);
        },
      };
    } catch (error) {
      await close(host);
      await close(api);
      if (error.code !== 'EADDRINUSE' && error.code !== 'ERR_SOCKET_BAD_PORT') throw error;
    }
  }
  throw new Error('Could not reserve an isolated Host/API port pair');
}
