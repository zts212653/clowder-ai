import { parentPort, workerData } from 'node:worker_threads';

const { tsImport } = await import('tsx/esm/api');
if (workerData.journal) {
  const { openTripwireLog } = await tsImport(
    new URL('../../src/infrastructure/telemetry/cpu/event-loop-tripwire-log.ts', import.meta.url).href,
    import.meta.url,
  );
  const { EventLoopResourceObserver } = await tsImport(
    new URL('../../src/infrastructure/telemetry/cpu/event-loop-resource-observer.ts', import.meta.url).href,
    import.meta.url,
  );
  const code = openTripwireLog(workerData.journal);
  let failure = false;
  if (workerData.blocked) {
    const resource = new EventLoopResourceObserver(workerData.journal, undefined, () => {
      failure = true;
    });
    resource.observe({ startMs: 0 }, undefined, 2000);
    resource.close();
  } else {
    const resource = openTripwireLog(workerData.journal, 'resources');
    for (let i = 0; i < 20; i++) resource.write({ kind: 'resource-fixture', padding: 'x'.repeat(6000) });
    resource.close();
  }
  parentPort.postMessage({ failure, codeStatus: code.write({ kind: 'code-survives' }).status });
  code.close();
  parentPort.close();
} else {
  const { ProcessWitness } = await tsImport(
    new URL('../../src/infrastructure/telemetry/cpu/process-witness.ts', import.meta.url).href,
    import.meta.url,
  );
  const witness = new ProcessWitness(workerData.mainThreadId);
  witness.healthy(performance.now());
  parentPort.postMessage(witness.capture({}, performance.now()));
  parentPort.close();
}
