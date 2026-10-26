import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const origin = 'https://f322-chat-real-page.test';

// Reusable compile-only entry: importing/running this never starts a browser or server.
export async function buildChatProof(entryFile = 'f322-chat-real-page.tsx') {
  const previousCwd = process.cwd();
  process.chdir(webRoot); // Tailwind v3 content globs resolve against cwd.
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
          input: path.join(fixtureRoot, entryFile),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const entry = outputs.find((item) => item.type === 'chunk' && item.isEntry);
    assert.ok(entry);
    const css = outputs
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
    assert.ok(css.includes('.grid-cols-'), 'Tailwind utilities are present in the compiled product stylesheet');
    return { script: entry.code, css };
  } finally {
    process.chdir(previousCwd);
  }
}
