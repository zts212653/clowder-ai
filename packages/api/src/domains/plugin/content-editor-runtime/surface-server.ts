import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { extname } from 'node:path';
import type { ContentEditorProviderContribution } from '@clowder-ai/plugin-contract';
import type { VerifiedPluginPackage } from '../external-runtime/types.js';
import { snapshotEditorAssets } from './surface-assets.js';

export interface EditorSurfaceServer {
  readonly origin: string;
  readonly pathPrefix: string;
  close(): Promise<void>;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

export async function startEditorSurfaceServer(options: {
  readonly package: VerifiedPluginPackage;
  readonly contributions: readonly ContentEditorProviderContribution[];
  readonly parentOrigin: string;
  readonly isCurrent: () => Promise<boolean>;
  readonly onFailure?: () => void;
}): Promise<EditorSurfaceServer> {
  const parent = new URL(options.parentOrigin);
  if (
    parent.origin !== options.parentOrigin ||
    !['http:', 'https:'].includes(parent.protocol) ||
    parent.username ||
    parent.password
  ) {
    throw new Error('invalid editor parent origin');
  }
  const files = await snapshotEditorAssets(options.package, options.contributions);
  const hostname = `editor-${randomUUID().replaceAll('-', '')}.localhost`;
  const pathPrefix = `/packages/${randomUUID()}/assets/`;
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "worker-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${parent.origin}`,
  ].join('; ');
  let origin = '';
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.host !== new URL(origin).host) {
        res.writeHead(421).end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      if (!req.url?.startsWith(pathPrefix)) {
        res.writeHead(404).end();
        return;
      }
      const bytes = files.get(req.url.slice(pathPrefix.length));
      if (!bytes) {
        res.writeHead(404).end();
        return;
      }
      if (!(await options.isCurrent())) {
        res.writeHead(410).end();
        return;
      }
      res.writeHead(200, {
        'content-type': MIME_TYPES[extname(req.url)] ?? 'application/octet-stream',
        'content-length': bytes.length,
        'content-security-policy': policy,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
        'cross-origin-resource-policy': 'same-origin',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=(), payment=()',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('editor server has no port');
  }
  origin = `http://${hostname}:${address.port}`;
  server.on('error', () => options.onFailure?.());
  return { origin, pathPrefix, close: () => closeServer(server) };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolveClose, reject) =>
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolveClose();
    }),
  );
}
