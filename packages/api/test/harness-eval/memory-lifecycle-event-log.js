/**
 * An in-memory F266 lifecycle event log with the Redis log's append contract: a
 * duplicate event id is idempotent before the sequence is compared, and a stale
 * expected sequence is a conflict. Kept out of the `.test.js` files so importing it
 * never registers another suite's tests.
 */
export class MemoryLifecycleEventLog {
  logs = new Map();
  seen = new Set();

  async append(event, expectedSequence) {
    const subjectId = event.caseId ?? event.verdictId;
    if (this.seen.has(event.eventId)) return { outcome: 'duplicate' };
    const log = this.logs.get(subjectId) ?? [];
    if (log.length !== expectedSequence) return { outcome: 'conflict', actualSequence: log.length };
    this.seen.add(event.eventId);
    this.logs.set(subjectId, [...log, structuredClone(event)]);
    return { outcome: 'appended', sequence: log.length };
  }

  async read(subjectId, fromSequence = 0) {
    return structuredClone((this.logs.get(subjectId) ?? []).slice(fromSequence));
  }

  async listVerdictIds() {
    return [...this.logs.keys()].sort();
  }

  async listSubjectIds() {
    return this.listVerdictIds();
  }
}
