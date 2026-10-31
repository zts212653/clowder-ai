import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';

/** Transparent TCP transport: all API/Socket.IO bytes come from the real local API. */
export async function startReconnectTransport(upstream, port) {
  const url = new URL(upstream);
  assert.equal(url.protocol, 'http:');
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  const connections = new Set();
  const server = createServer((client) => {
    const target = createConnection({ host: url.hostname, port: Number(url.port) });
    connections.add(client);
    connections.add(target);
    for (const [socket, peer] of [
      [client, target],
      [target, client],
    ]) {
      socket.on('error', () => peer.destroy());
      socket.on('close', () => {
        connections.delete(socket);
        peer.destroy();
      });
    }
    client.pipe(target);
    target.pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    cutConnections() {
      const count = connections.size;
      for (const socket of connections) socket.destroy();
      return count;
    },
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
