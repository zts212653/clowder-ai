// Match the existing state/execution-worker boundary: no inherited watch/preload hooks.
if (new URL(import.meta.url).pathname.endsWith('.ts')) {
  await (await import('tsx/esm/api')).tsImport(
    new URL('./event-loop-tripwire-worker.ts', import.meta.url).href,
    import.meta.url,
  );
} else {
  await import('./event-loop-tripwire-worker.js');
}
