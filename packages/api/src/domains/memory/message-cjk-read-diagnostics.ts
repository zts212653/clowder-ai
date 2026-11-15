/** Counts only bodies already admitted to the existing SQLite matcher. No body is retained. */
export interface CjkReadSnapshot {
  bodyVisits: number;
  bodyUtf16: number;
  checkpoints: number;
  checkpointLimit: 8;
  outcome: 'running' | 'fulfilled' | 'rejected';
  complete: boolean;
  returnedRows: number | null;
  elapsedMs: number;
  resourcesBefore: NativeReadResources | null;
  resourcesAfter: NativeReadResources | null;
  resourceDelta: NativeReadResourceDelta | null;
}

/** Eight geometric IPC checkpoints/job, not one event per body. A killed worker cannot report a finish. */
export function observeCjkRead(sink: (snapshot: CjkReadSnapshot) => void) {
  let bodyVisits = 0;
  let bodyUtf16 = 0;
  let checkpoints = 0;
  let nextCheckpoint = 256;
  let started = 0;
  let resourcesBefore: NativeReadResources | null = null;
  const report = (outcome: CjkReadSnapshot['outcome'], returnedRows: number | null) => {
    try {
      // Only the existing terminal event samples the closing process counters.
      const resourcesAfter = outcome === 'running' ? null : captureNativeReadResources();
      sink({
        bodyVisits,
        bodyUtf16,
        checkpoints,
        checkpointLimit: 8,
        outcome,
        complete: outcome !== 'running',
        returnedRows,
        elapsedMs: performance.now() - started,
        resourcesBefore,
        resourcesAfter,
        resourceDelta: nativeReadResourceDelta(resourcesBefore, resourcesAfter),
      });
    } catch {
      /* Diagnostics cannot affect the SQLite callback or its native result. */
    }
  };
  return {
    wrap(match: (content: string) => number) {
      return (content: string) => {
        bodyVisits++;
        bodyUtf16 += content.length;
        if (bodyVisits === nextCheckpoint && checkpoints < 8) {
          checkpoints++;
          nextCheckpoint *= 4;
          report('running', null);
        }
        return match(content);
      };
    },
    read<T extends readonly unknown[]>(run: () => T): T {
      started = performance.now();
      resourcesBefore = captureNativeReadResources();
      try {
        const rows = run();
        report('fulfilled', rows.length);
        return rows;
      } catch (error) {
        report('rejected', null);
        throw error;
      }
    },
  };
}

import {
  captureNativeReadResources,
  type NativeReadResourceDelta,
  type NativeReadResources,
  nativeReadResourceDelta,
} from '../../infrastructure/sqlite-native-read-resources.js';
