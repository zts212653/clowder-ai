// Source and emitted code use the same worker boundary, with the existing source loader.
if (new URL(import.meta.url).pathname.endsWith('.ts')) {
  await (await import('tsx/esm/api')).tsImport(new URL('./entry.ts', import.meta.url).href, import.meta.url);
} else {
  await import('./entry.js');
}
