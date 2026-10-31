import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { type AudioCaptureTarget, audioCaptureTargetFromStatus } from './audio-capture-target.js';

export const CONTROLLER_LEASE_TTL_S = 15;
export type CaptureLease = {
  token: string;
  threadId: string;
  heartbeat: NodeJS.Timeout;
  expiresAtMs: number;
  target: AudioCaptureTarget | null;
};
type StartReservation = { threadId: string; meetingId: string; controllerId: string; inFlight: boolean };
type Observation = { lease: CaptureLease | null; start: StartReservation | null };
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** PCM stopping is distinct from completion of the original sidecar transaction. */
export function audioCaptureFinalized(value: unknown): boolean {
  const status = object(value);
  return status?.running === false && status.lifecycle_state === 'stopped' && status.controller_lease === null;
}

/** The API remains the sole private lease owner; reservations survive unknown transport outcomes. */
export class AudioCaptureController {
  private lease: CaptureLease | null = null;
  private start: StartReservation | null = null;
  constructor(
    private readonly serviceUrl: () => string,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
  ) {}
  snapshot(): Observation {
    return { lease: this.lease, start: this.start };
  }
  activeLease(): CaptureLease | null {
    return this.lease && Date.now() < this.lease.expiresAtMs ? this.lease : null;
  }
  expired(): boolean {
    return Boolean(this.lease && Date.now() >= this.lease.expiresAtMs);
  }
  reserve(threadId: string, meetingId: string): StartReservation | null {
    if (this.lease || this.start) return null;
    this.start = { threadId, meetingId, controllerId: `api-runtime:${process.pid}:${randomUUID()}`, inFlight: true };
    return this.start;
  }
  accepted(start: StartReservation, data: Record<string, unknown>): boolean {
    const token = data.lease_token;
    if (this.start !== start || typeof token !== 'string' || !token) return false;
    const heartbeat = setInterval(() => void this.renew(), (CONTROLLER_LEASE_TTL_S * 1000) / 3);
    heartbeat.unref();
    this.lease = {
      token,
      threadId: start.threadId,
      heartbeat,
      expiresAtMs: Date.now() + CONTROLLER_LEASE_TTL_S * 1000,
      target: audioCaptureTargetFromStatus(data.status),
    };
    this.start = null;
    return true;
  }
  rejected(start: StartReservation): void {
    if (this.start === start) this.start = null;
  }
  settled(start: StartReservation): void {
    start.inFlight = false;
  }
  release(lease: CaptureLease): void {
    clearInterval(lease.heartbeat);
    if (this.lease === lease) this.lease = null;
  }
  observe(data: unknown, before: Observation): void {
    if (!audioCaptureFinalized(data)) return;
    if (before.lease && this.lease === before.lease) this.release(before.lease);
    const status = object(data),
      start = before.start;
    if (
      start &&
      this.start === start &&
      !start.inFlight &&
      status?.thread_id === start.threadId &&
      status.meeting_id === start.meetingId &&
      status.controller_id === start.controllerId
    )
      this.start = null;
  }
  status(data: unknown): unknown {
    if (!this.start) return data;
    return {
      ...object(data),
      controller_start: {
        thread_id: this.start.threadId,
        meeting_id: this.start.meetingId,
        phase: this.start.inFlight ? 'starting' : 'unconfirmed',
      },
    };
  }
  private async renew(): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    try {
      const response = await fetch(`${this.serviceUrl()}/lease`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lease_token: lease.token, thread_id: lease.threadId }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        lease.expiresAtMs = 0;
        this.log.warn({ status: response.status }, 'audio lease rejected; await finalized sidecar observation');
      } else if (this.lease === lease) lease.expiresAtMs = Date.now() + CONTROLLER_LEASE_TTL_S * 1000;
    } catch (error) {
      this.log.warn({ err: error }, 'audio lease renewal failed; capture expires at the sidecar');
    }
  }
  async close(): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    this.release(lease);
    try {
      const response = await fetch(`${this.serviceUrl()}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lease_token: lease.token, reason: 'runtime-graceful-shutdown' }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        this.log.warn(
          { status: response.status },
          'audio graceful stop unconfirmed; sidecar lease expiry remains active',
        );
    } catch (error) {
      this.log.warn({ err: error }, 'audio graceful stop unconfirmed; sidecar lease expiry remains active');
    }
  }
}
