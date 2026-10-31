import { parentPort, workerData } from 'node:worker_threads';

const request = workerData as { moduleUrl: string; exportName: string; input: unknown };
try {
  // The production target is compiled JS. tsImport also resolves .js imports in
  // source modules when running the development server or source-based tests.
  const module: Record<string, unknown> =
    import.meta.url.endsWith('.ts') || request.moduleUrl.endsWith('.ts')
      ? await (await import('tsx/esm/api')).tsImport(request.moduleUrl, import.meta.url)
      : await import(request.moduleUrl);
  const operation = module[request.exportName];
  if (typeof operation !== 'function') throw new Error(`Missing worker export: ${request.exportName}`);
  const value: unknown = await operation(request.input);
  parentPort?.postMessage({ ok: true, value });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    },
  });
} finally {
  parentPort?.close();
}
