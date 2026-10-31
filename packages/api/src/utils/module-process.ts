import type { ModuleProcessMetrics } from './module-worker-timing.js';

interface ProcessProbe {
  wall: number;
  cpuMs: number;
}
function probe(): ProcessProbe | undefined {
  try {
    const cpu = process.cpuUsage();
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const wall = performance.now();
    if (!Number.isFinite(cpuMs) || cpuMs < 0 || !Number.isFinite(wall)) return undefined;
    return { wall, cpuMs };
  } catch {
    // Optional measurement must not replace the operation's result or error.
    return undefined;
  }
}
function elapsed(start: ProcessProbe | undefined) {
  if (!start) return undefined;
  const end = probe();
  if (!end || end.wall < start.wall || end.cpuMs < start.cpuMs) return undefined;
  return { wallMs: end.wall - start.wall, cpuMs: end.cpuMs - start.cpuMs };
}
function measuredWork(
  moduleLoad: ReturnType<typeof elapsed>,
  operationStarted: boolean,
  operationWork: ReturnType<typeof elapsed>,
): ModuleProcessMetrics | undefined {
  if (!moduleLoad || (operationStarted && !operationWork)) return undefined;
  return {
    moduleLoadWallMs: moduleLoad.wallMs,
    moduleLoadProcessCpuMs: moduleLoad.cpuMs,
    operationStarted,
    operationWallMs: operationWork?.wallMs ?? 0,
    operationProcessCpuMs: operationWork?.cpuMs ?? 0,
  };
}
function errorFields(error: unknown) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
}

/** One trusted operation per process; native work can be terminated by the parent. */
process.once(
  'message',
  async (request: { moduleUrl: string; exportName: string; input: unknown; captureTiming?: boolean }) => {
    const capture = request.captureTiming === true;
    let moduleLoad: ReturnType<typeof elapsed>;
    let operationWork: ReturnType<typeof elapsed>;
    let operationStarted = false;
    try {
      const loadStarted = capture ? probe() : undefined;
      let module: Record<string, unknown>;
      try {
        module =
          import.meta.url.endsWith('.ts') || request.moduleUrl.endsWith('.ts')
            ? await (await import('tsx/esm/api')).tsImport(request.moduleUrl, import.meta.url)
            : await import(request.moduleUrl);
      } finally {
        if (capture) moduleLoad = elapsed(loadStarted);
      }
      const operation = module[request.exportName];
      if (typeof operation !== 'function') throw new Error(`Missing worker export: ${request.exportName}`);
      operationStarted = true;
      const operationBegan = capture ? probe() : undefined;
      let value: unknown;
      try {
        value = await operation(request.input);
      } finally {
        if (capture) operationWork = elapsed(operationBegan);
      }
      const processMetrics = measuredWork(moduleLoad, operationStarted, operationWork);
      process.send?.({ ok: true, value, ...(processMetrics ? { processMetrics } : {}) }, () => process.exit(0));
    } catch (error) {
      const processMetrics = measuredWork(moduleLoad, operationStarted, operationWork);
      process.send?.(
        {
          ok: false,
          error: errorFields(error),
          ...(processMetrics ? { processMetrics } : {}),
        },
        () => process.exit(1),
      );
    }
  },
);
