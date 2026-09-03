import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  outfile: 'dist/assets/app.js',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
});
