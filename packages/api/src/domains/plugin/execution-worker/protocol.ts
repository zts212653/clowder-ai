import type { ReadableStream } from 'node:stream/web';
import type { MessagePort } from 'node:worker_threads';

export type RemoteValue =
  | { kind: 'data'; value: unknown }
  | { kind: 'array'; items: readonly RemoteValue[] }
  | { kind: 'object'; entries: readonly (readonly [string, RemoteValue])[] }
  | { kind: 'function'; id: string; mode: 'async' | 'sync' | 'stream' | 'teardown' }
  | { kind: 'iterator'; next: RemoteValue; end: RemoteValue }
  | { kind: 'readable'; stream: ReadableStream; objectMode: boolean; highWaterMark: number }
  | { kind: 'signal'; id: string; state: SharedArrayBuffer; reason: RemoteValue }
  | { kind: 'error' | 'return-error'; id: string; name: string; message: string; stack?: string; fields: RemoteValue };

export interface RemoteCallContext {
  readonly rootId: string;
  readonly authorityId?: string;
  readonly teardown?: boolean;
}

export const MAX_PENDING_EXECUTION_REQUESTS = 64;

export type RemoteMessage =
  | {
      kind: 'call';
      id: string;
      target: string;
      args: RemoteValue;
      context: RemoteCallContext;
      synchronous?: { state: SharedArrayBuffer; port: MessagePort };
    }
  | { kind: 'result'; id: string; returned: boolean; value: RemoteValue }
  | { kind: 'abort'; id: string; reason: RemoteValue }
  | { kind: 'release'; ids: readonly string[] };

export class PluginExecutionWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginExecutionWorkerError';
  }
}

/** Keep only explicitly retained Host capabilities for the activation lifetime. */
export class RetainedRemoteValue {
  constructor(readonly value: unknown) {}
}

/** These are Host-owned lifecycle/disposal calls, bounded by their live owner rather than business traffic. */
export class TeardownRemoteValue {
  constructor(readonly value: unknown) {}
}
