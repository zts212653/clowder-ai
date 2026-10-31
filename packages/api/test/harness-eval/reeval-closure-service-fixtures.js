import { ReevalClosureService } from '../../dist/infrastructure/harness-eval/reeval-closure-service.js';

export const root = {
  verdictId: 'verdict-a',
  domainId: 'eval:capability-wakeup',
  targetOwnerCatId: 'codex-sol',
  assignedEvalCatId: 'gpt52',
  reevalWithinHours: 168,
};

export const ref = (kind, value) => ({ kind, availability: 'available', value });

export function opened(overrides = {}) {
  return {
    eventId: 'open-verdict-a',
    verdictId: root.verdictId,
    domainId: root.domainId,
    type: 'verdict_opened',
    actor: { kind: 'migration', id: 'f266-test' },
    occurredAt: '2026-07-18T00:00:00.000Z',
    reason: 'seed from immutable verdict artifact',
    refs: [ref('verdict', 'docs/verdict-a.md')],
    ...overrides,
  };
}

class InMemoryCasEventLog {
  events = new Map();
  seen = new Set();

  async append(event, expectedSequence) {
    if (this.seen.has(event.eventId)) return { outcome: 'duplicate' };
    const existing = this.events.get(event.verdictId) ?? [];
    if (existing.length !== expectedSequence) {
      return { outcome: 'conflict', actualSequence: existing.length };
    }
    this.seen.add(event.eventId);
    this.events.set(event.verdictId, [...existing, structuredClone(event)]);
    return { outcome: 'appended', sequence: existing.length };
  }

  async read(verdictId, fromSequence = 0) {
    return structuredClone((this.events.get(verdictId) ?? []).slice(fromSequence));
  }

  async listVerdictIds() {
    return [...this.events.keys()].sort();
  }
}

export function command(type, eventId, expectedSequence, overrides = {}) {
  return {
    type,
    eventId,
    verdictId: root.verdictId,
    expectedSequence,
    reason: `${type} with evidence`,
    refs: [ref('message', `thread:${eventId}`)],
    ...overrides,
  };
}

export async function createServiceHarness() {
  const eventLog = new InMemoryCasEventLog();
  const roots = new Map([[root.verdictId, root]]);
  let clockTick = 0;
  const service = new ReevalClosureService({
    eventLog,
    loadRoot: async (verdictId) => roots.get(verdictId),
    loadBootstrap: async (verdictId) => {
      const loadedRoot = roots.get(verdictId);
      return loadedRoot
        ? [
            opened({
              eventId: `open-${verdictId}`,
              verdictId,
              domainId: loadedRoot.domainId,
            }),
          ]
        : undefined;
    },
    now: () => {
      clockTick += 1;
      return new Date(Date.parse('2026-07-18T01:00:00.000Z') + clockTick * 1_000).toISOString();
    },
  });
  await eventLog.append(opened(), 0);
  return { eventLog, roots, service };
}
