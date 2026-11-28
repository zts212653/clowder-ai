import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  assetMimes,
  listPackages,
  readPackage,
  themeRoots,
} from '../../../../api/src/domains/console-themes/packages.js';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export async function startArtifactPreview(port = 0) {
  const bundle = await build({
    entryPoints: [path.join(web, 'test/browser/fixtures/message-artifacts-client.ts')],
    tsconfig: path.join(web, 'tsconfig.json'),
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    define: { 'process.env': '{}', 'process.env.NEXT_PUBLIC_API_URL': '""', 'process.env.NODE_ENV': '"test"' },
  });
  const roots = themeRoots(path.join(web, '.no-fixture-packages'), path.join(web, 'public/pdl/themes'));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://fixture');
      if (url.pathname === '/') {
        res.setHeader('content-type', 'text/html');
        res.end(
          '<!doctype html><html><head><meta charset="utf-8"><title>Host pending decisions fixture</title></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>',
        );
      } else if (url.pathname === '/fixture.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(bundle.outputFiles[0].contents);
      } else if (url.pathname === '/fixture-doc') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ content: await readFile(path.join(web, '../../docs/SOP.md'), 'utf8') }));
      } else if (url.pathname === '/api/console-themes/packages') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ packages: await listPackages(roots) }));
      } else if (/^\/api\/console-themes\/packages\/(default|v2)\/assets\/[^/]+$/.test(url.pathname)) {
        const parts = url.pathname.split('/');
        const filename = decodeURIComponent(parts[6]);
        if (filename.includes('/') || filename.includes('..')) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.setHeader('content-type', assetMimes[path.extname(filename)] || 'application/octet-stream');
        res.end(await readFile(path.join(web, 'public/pdl/themes', parts[4], 'assets', filename)));
      } else if (/^\/api\/console-themes\/packages\/(default|v2)$/.test(url.pathname)) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(await readPackage(roots, url.pathname.split('/').pop()!)));
      } else {
        const file = path.resolve(web, 'public', '.' + decodeURIComponent(url.pathname));
        if (!file.startsWith(path.join(web, 'public') + path.sep)) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.setHeader(
          'content-type',
          assetMimes[path.extname(file)] ||
            ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' } as Record<string, string>)[
              path.extname(file)
            ] ||
            'application/octet-stream',
        );
        res.end(await readFile(file));
      }
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: 'http://127.0.0.1:' + address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
if (process.argv.includes('--serve')) {
  void startArtifactPreview(Number(process.env.ARTIFACT_PREVIEW_PORT || 3289)).then((app) => console.log(app.url));
}
