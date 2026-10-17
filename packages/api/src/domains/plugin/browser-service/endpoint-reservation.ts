import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import { BrowserServiceTransportError } from './transport-policy.js';

/** Close serving, including keepalive connections; repeated cleanup remains safe. */
export async function closeBrowserEndpoint(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) =>
      error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING') ? reject(error) : resolve(),
    );
  });
  server.closeAllConnections();
  await closed;
}

/** Persist an assigned port once. Busy/corrupt assignments never silently rotate origins. */
export async function reserveBrowserEndpoint(
  server: Server,
  directory: string,
  instanceId: string,
  contributionId: string,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = { instanceId, contributionId };
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const filename = path.join(directory, `${key}.json`);
  let port = 0;
  let existing = false;
  try {
    const record = JSON.parse(await readFile(filename, 'utf8'));
    if (
      record.version !== 1 ||
      record.instanceId !== instanceId ||
      record.contributionId !== contributionId ||
      !Number.isInteger(record.port) ||
      record.port < 1024 ||
      record.port > 65535
    )
      throw new Error('Invalid endpoint identity');
    port = record.port;
    existing = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw new BrowserServiceTransportError('BROWSER_SERVICE_UNAVAILABLE');
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        server.off('listening', ready);
        reject(error);
      };
      const ready = () => {
        server.off('error', fail);
        resolve();
      };
      server.once('error', fail);
      server.once('listening', ready);
      server.listen({ host: '127.0.0.1', port, exclusive: true });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing endpoint address');
    if (!existing) {
      // Cross-process races fail closed: a competing record is never overwritten.
      const handle = await open(filename, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, ...identity, port: address.port }));
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return `http://127.0.0.1:${address.port}`;
  } catch {
    await closeBrowserEndpoint(server);
    throw new BrowserServiceTransportError('BROWSER_SERVICE_UNAVAILABLE');
  }
}
