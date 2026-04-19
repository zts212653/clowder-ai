import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
    setupFiles: ['src/test-setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@ricky0123/vad-web': path.resolve(__dirname, 'src/__mocks__/vad-web.ts'),
      'next/font/google': path.resolve(__dirname, 'src/__mocks__/next-font-google.ts'),
    },
  },
});
