import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dependencyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('vite/package.json'))), '../../..');
process.chdir(webRoot);
const cat = {
  id: 'codex',
  carrier: 'cli',
  displayName: '砚砚',
  color: { primary: '#6B5443', secondary: '#E9DCCF' },
  avatar: '/avatars/maine-coon.png',
};
const server = await createServer({
  root: webRoot,
  configFile: false,
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': path.join(webRoot, 'src'),
      'next/font/google': path.join(webRoot, 'src/__mocks__/next-font-google.ts'),
      'next/font/local': path.join(webRoot, 'src/__mocks__/next-font-local.ts'),
    },
  },
  define: { 'process.env': JSON.stringify({ NODE_ENV: 'development', NEXT_PUBLIC_API_URL: '' }) },
  server: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
    fs: { allow: [path.resolve(webRoot, '../..'), dependencyRoot] },
  },
  plugins: [
    {
      name: 'isolated-composer-preview',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/api/')) {
            const route = req.url.split('?')[0];
            const body =
              route === '/api/cats'
                ? { cats: [cat] }
                : route === '/api/config/cat-order'
                  ? { catOrder: ['codex'] }
                  : route === '/api/config/co-creator'
                    ? { name: '枫哥', aliases: [], mentionPatterns: [] }
                    : route?.includes('chat-references')
                      ? { references: [], targets: [] }
                      : { threads: [], items: [], executions: [], preferences: {}, effective: { mode: 'group' } };
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(body));
            return;
          }
          if (req.url?.split('?')[0] === '/') {
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(
              '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/test/browser/fixtures/issue1863-composer.tsx"></script></html>',
            );
            return;
          }
          next();
        });
      },
    },
  ],
});
await server.listen();
server.printUrls();
