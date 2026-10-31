import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'vite';
import { webRoot } from './f322-chat-real-page-build.mjs';

export const menuOrigin = 'https://f322-workspace-menu.test';
export async function buildWorkspaceMenuPage() {
  const prior = process.cwd();
  process.chdir(webRoot);
  try {
    const result = await build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      resolve: { alias: { '@': path.join(webRoot, 'src') } },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(menuOrigin) },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(webRoot, 'test/browser/fixtures/f322-workspace-menu-page.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const output = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const entry = output.find((item) => item.type === 'chunk' && item.isEntry);
    const css = output
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
    assert.ok(entry && css.includes('.overflow-hidden'), 'production utilities must accompany the real chrome');
    return { script: entry.code, css };
  } finally {
    process.chdir(prior);
  }
}

export function routeWorkspaceMenuAssets(route, built, unexpected) {
  const url = new URL(route.request().url());
  const assets = {
    '/proof.js': { contentType: 'text/javascript', body: built.script },
    '/proof.css': { contentType: 'text/css', body: built.css },
    '/': {
      contentType: 'text/html',
      body: '<!doctype html><html><head><link rel="stylesheet" href="/proof.css"></head><body><div id="root"></div><script type="module" src="/proof.js"></script></body></html>',
    },
  };
  if (url.origin === menuOrigin && assets[url.pathname]) return route.fulfill(assets[url.pathname]);
  if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
  unexpected.push(route.request().url());
  return route.abort();
}
