import { availableParallelism } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { vitestReporters } from '../../scripts/test-file-timing/vitest-file-timing-reporter.mjs';

// Worker cap. 2fad783b61 (2026-05) limited workers to 25% after running every file at once on a 16-core Mac hit
// random 5s timeouts; 25% is 4 workers there. A percentage also leaves a 4-core machine with a single worker, so
// below 16 cores use every core but one, never more than 4. At 16 cores and above this is the same 25% as before.
const cores = availableParallelism();
const defaultWorkers = Math.max(1, Math.floor(cores / 4), Math.min(4, cores - 1));

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    reporters: vitestReporters(),
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    maxWorkers: process.env.CAT_CAFE_WEB_TEST_WORKERS ?? defaultWorkers,
    testTimeout: 10_000,
    // Component tests (.tsx) get a jsdom window. Logic tests (.ts) run in plain Node, which saves building a window
    // for every file; a .ts test that needs the DOM says so with `// @vitest-environment jsdom` at its top.
    projects: [
      { extends: true, test: { name: 'tsx', include: ['src/**/__tests__/**/*.test.tsx'] } },
      {
        extends: true,
        test: {
          name: 'ts',
          environment: 'node',
          include: ['src/**/__tests__/**/*.test.ts'],
          exclude: ['src/pdl/__tests__/**/*.test.ts'],
        },
      },
      { extends: true, test: { name: 'pdl', environment: 'jsdom', include: ['src/pdl/__tests__/**/*.test.ts'] } },
    ],
    // Every test file runs in a fresh worker, so it re-imports everything it uses. @cat-cafe/shared is a workspace
    // package, which Vite would transform and evaluate module by module (about 300 of them) in each of those
    // workers; letting Node load the compiled package natively cut import time by about a third.
    server: { deps: { external: [/\/packages\/shared\/dist\//] } },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@ricky0123/vad-web': path.resolve(__dirname, 'src/__mocks__/vad-web.ts'),
      'next/font/google': path.resolve(__dirname, 'src/__mocks__/next-font-google.ts'),
      'next/font/local': path.resolve(__dirname, 'src/__mocks__/next-font-local.ts'),
    },
  },
});
