/**
 * F117 KD-22 (J4): what the process behind an invocation is doing, read by the member output timeout
 * to decide whether a silent member is still working. cli-spawn registers each process it probes
 * under the invocation it serves; a carrier without a probed process reads as `absent`.
 */
export type ProcessActivity = 'busy' | 'idle' | 'dead';

const readers = new Map<string, () => ProcessActivity>();

/** Register the process serving `invocationId`; returns the unregister call for its teardown. */
export function registerProcessActivity(invocationId: string, read: () => ProcessActivity): () => void {
  readers.set(invocationId, read);
  return () => {
    if (readers.get(invocationId) === read) readers.delete(invocationId);
  };
}

export function readProcessActivity(invocationId: string): ProcessActivity | 'absent' {
  return readers.get(invocationId)?.() ?? 'absent';
}
