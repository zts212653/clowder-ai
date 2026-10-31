import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

type ParseOutcome =
  | { kind: 'returned'; success: boolean; paths: (string | number)[][] }
  | { kind: 'threw'; message: string }
  | { kind: 'timed-out' };

/** The watchdog runs outside the worker so a synchronous refinement cannot lock the test host. */
function parseInWorker(timebase: { numerator: number; denominator: number }): Promise<ParseOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { register } = await import(workerData.loader);
        register();
        const { videoProjectTimebaseSchema } = await import(workerData.schema);
        parentPort.postMessage({ kind: 'ready' });
        parentPort.once('message', (value) => {
          try {
            const parsed = videoProjectTimebaseSchema.safeParse(value);
            parentPort.postMessage({ kind: 'returned', success: parsed.success,
              paths: parsed.success ? [] : parsed.error.issues.map(issue => issue.path) });
          } catch (error) {
            parentPort.postMessage({ kind: 'threw', message: String(error) });
          }
        });
      })().catch(error => parentPort.postMessage({ kind: 'startup-error', message: String(error) }));
    `,
      {
        eval: true,
        workerData: {
          loader: import.meta.resolve('tsx/esm/api'),
          schema: new URL('../types/video-project-timeline.ts', import.meta.url).href,
        },
      },
    );
    let timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Timebase worker did not load the actual schema within 3 seconds'));
    }, 3000);
    worker.once('error', (error) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(error);
    });
    worker.on('message', (outcome: ParseOutcome | { kind: 'ready' } | { kind: 'startup-error'; message: string }) => {
      clearTimeout(timer);
      if (outcome.kind === 'ready') {
        timer = setTimeout(() => {
          void worker.terminate();
          resolve({ kind: 'timed-out' });
        }, 500);
        worker.postMessage(timebase);
      } else if (outcome.kind === 'startup-error') {
        void worker.terminate();
        reject(new Error(outcome.message));
      } else {
        void worker.terminate();
        resolve(outcome);
      }
    });
  });
}

describe('video-project reduced timebase guards', () => {
  it.each([
    { numerator: Number.POSITIVE_INFINITY, denominator: 1 },
    { numerator: 1, denominator: Number.POSITIVE_INFINITY },
    JSON.parse('{"numerator":1e400,"denominator":30}') as { numerator: number; denominator: number },
    { numerator: 1.5, denominator: 30 },
    { numerator: 1, denominator: 30.5 },
    { numerator: 0, denominator: 30 },
    { numerator: 1, denominator: 0 },
    { numerator: -1, denominator: 30 },
    { numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1 },
  ])('rejects dirty numeric input without throwing or hanging: %o', async (value) => {
    const outcome = await parseInWorker(value);
    expect(outcome.kind).toBe('returned');
    if (outcome.kind === 'returned') {
      expect(outcome.success).toBe(false);
      expect(outcome.paths.some((path) => path[0] === 'numerator' || path[0] === 'denominator')).toBe(true);
    }
  });

  it.each([
    { numerator: Number.MAX_SAFE_INTEGER, denominator: 1 },
    { numerator: Number.MAX_SAFE_INTEGER, denominator: Number.MAX_SAFE_INTEGER - 1 },
    { numerator: 1, denominator: Number.MAX_SAFE_INTEGER },
  ])('accepts maximum safe reduced rational %j', async (value) => {
    expect(await parseInWorker(value)).toEqual({ kind: 'returned', success: true, paths: [] });
  });

  it('rejects a finite safe rational with a common divisor', async () => {
    expect(await parseInWorker({ numerator: Number.MAX_SAFE_INTEGER - 1, denominator: 2 })).toEqual({
      kind: 'returned',
      success: false,
      paths: [[]],
    });
  });
});
