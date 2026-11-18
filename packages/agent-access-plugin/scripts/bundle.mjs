import { build } from 'esbuild';

await build({
  entryPoints: ['src/entrypoint.ts'],
  outfile: 'dist/plugin/entrypoint.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
