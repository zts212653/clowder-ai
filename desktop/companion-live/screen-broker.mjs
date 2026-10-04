import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Current-frame transport only. Pixels remain in memory; the socket is owner-only. */
export async function createScreenBroker(readFrame, authorize) {
  const folder = await mkdtemp(join(tmpdir(), 'f317-screen-'));
  const path = join(folder, 'frame.sock');
  const server = createServer((socket) => {
    socket.setTimeout(2000, () => socket.destroy());
    let input = '';
    socket.on('error', () => {});
    socket.on('data', (bytes) => {
      input += bytes.toString();
      if (input.length > 4096) return socket.destroy();
      if (!input.includes('\n')) return;
      try {
        const request = JSON.parse(input);
        const frame = authorize(request) ? readFrame() : undefined;
        socket.end(`${JSON.stringify(frame ? { frame } : { error: 'No current authorized shared screen' })}\n`);
      } catch {
        socket.destroy();
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
  } catch (error) {
    server.close();
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(folder, { recursive: true, force: true });
    },
  };
}

export async function readSharedScreen(path, meta) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Shared screen unavailable')));
    socket.on('connect', () => socket.write(`${JSON.stringify(meta)}\n`));
    socket.on('error', reject);
    socket.on('data', (bytes) => {
      output += bytes.toString();
      if (output.length > 1_500_000) socket.destroy(new Error('Shared screen too large'));
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error('Invalid shared screen response'));
      }
    });
  });
}
