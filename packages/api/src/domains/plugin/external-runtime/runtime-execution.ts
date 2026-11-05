/**
 * External runtime — the execution record one supervised child process is tracked by.
 *
 * WHY ITS OWN UNIT (seventh-round review P1-B, sol): this record is what every phase of the
 * lifecycle reads and mutates — start, handshake, heartbeat, termination, cleanup — so it belongs
 * to none of them. `runtime-execution-cleanup.ts` already had to restate a narrow subset of this
 * shape to avoid importing the supervisor; giving the record a home of its own is what lets these
 * collaborators share one definition instead of drifting copies.
 */

import type { BrokerConnection } from '../host-broker/builtin-loopback.js';
import type { RuntimeHeartbeatController } from './runtime-heartbeat.js';
import type { ExternalStdioBrokerTransport } from './stdio-broker-transport.js';
import type { ExternalPluginProcess, VerifiedPluginPackage } from './types.js';

export interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

export interface RuntimeExecution {
  readonly pluginInstanceId: string;
  packageDigest: string;
  readonly ready: Deferred<void>;
  readonly closed: Deferred<void>;
  process?: ExternalPluginProcess;
  exit?: Awaited<ExternalPluginProcess['exited']>;
  locatedPackage?: VerifiedPluginPackage;
  connection?: BrokerConnection;
  transport?: ExternalStdioBrokerTransport;
  heartbeat?: RuntimeHeartbeatController;
  projected: boolean;
  started: boolean;
  ending: boolean;
  terminal?: Promise<void>;
}

export function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
