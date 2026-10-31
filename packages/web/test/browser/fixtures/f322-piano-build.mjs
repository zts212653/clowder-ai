import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'vite';
import { origin, webRoot } from './f322-chat-real-page-build.mjs';

export async function buildPianoPage() {
  const cwd = process.cwd();
  process.chdir(webRoot);
  try {
    const fixtureRoot = path.join(webRoot, 'test/browser/fixtures');
    const result = await build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      resolve: {
        alias: [
          { find: 'next/navigation', replacement: path.join(fixtureRoot, 'f322-shell-navigation.ts') },
          { find: '@/hooks/useSocket', replacement: path.join(fixtureRoot, 'f322-chat-socket.ts') },
          { find: '@', replacement: path.join(webRoot, 'src') },
        ],
      },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(webRoot, 'test/browser/fixtures/f322-piano-page.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const entry = outputs.find((item) => item.type === 'chunk' && item.isEntry);
    const css = outputs
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
    assert.ok(entry && css.includes('[data-message-piano-ready='), 'include the production scrollbar contract');
    return { script: entry.code, css };
  } finally {
    process.chdir(cwd);
  }
}
