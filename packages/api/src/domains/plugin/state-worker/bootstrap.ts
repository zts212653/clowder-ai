// Node can load this small source entry without evaluating the application on the main thread.
// The existing development loader resolves .js specifiers to their TypeScript source files.
if (new URL(import.meta.url).pathname.endsWith('.ts')) {
  await (await import('tsx/esm/api')).tsImport(new URL('./entry.ts', import.meta.url).href, import.meta.url);
} else {
  await import('./entry.js');
}
