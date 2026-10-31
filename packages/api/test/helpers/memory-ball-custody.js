/**
 * In-memory ball-custody stores for tests that need the real ingest/projector without Redis.
 * `racers` are appended once, right before the next fenced write, to model a concurrent writer.
 */
export class MemoryEventLog {
  events = [];
  /** Appended once, right before the first fenced write, to model a concurrent heartbeat. */
  racers = [];
  async append(event) {
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { appended: false, sequence: -1 };
    }
    this.events.push(structuredClone(event));
    return { appended: true, sequence: this.events.length - 1 };
  }
  async appendFenced(event, expectedSequence) {
    while (this.racers.length > 0) this.events.push(structuredClone(this.racers.shift()));
    // Same order as the production Lua (APPEND_FENCED_LUA): the seen-set is checked BEFORE the sequence fence, so a
    // duplicate is reported as a duplicate even when the sequence has moved. Reversing them masks races that only
    // a real Redis shows (review of #5049).
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { outcome: 'duplicate' };
    }
    const own = this.events.filter((candidate) => candidate.subjectKey === event.subjectKey).length;
    if (own !== expectedSequence) return { outcome: 'conflict', actualSequence: own };
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: expectedSequence };
  }
  async read(subjectKey, fromSequence = 0) {
    return this.events.filter((event) => event.subjectKey === subjectKey).slice(fromSequence);
  }
  async listSubjects() {
    return [...new Set(this.events.map((event) => event.subjectKey))];
  }
}

export class MemoryProjectionStore {
  projections = new Map();
  async get(subjectKey) {
    return structuredClone(this.projections.get(subjectKey) ?? null);
  }
  async save(projection) {
    this.projections.set(projection.subjectKey, structuredClone(projection));
  }
  async listSubjectKeys() {
    return [...this.projections.keys()];
  }
  async delete(subjectKey) {
    this.projections.delete(subjectKey);
  }
}
