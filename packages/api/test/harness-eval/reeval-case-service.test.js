import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ReevalCaseService } from '../../dist/infrastructure/harness-eval/reeval-case-service.js';

const caseId = `eval-case-v1-${'a'.repeat(64)}`;
const verdictId = 'capability-wakeup-2026-08-01-rich-messaging';
const commitSha = 'b'.repeat(40);
const ref = (kind, value) => ({ kind, availability: 'available', value });

const root = {
  caseId,
  domainId: 'eval:capability-wakeup',
  targetOwnerCatId: 'codex-sol',
  assignedEvalCatId: 'gpt52',
  reevalWithinHours: 168,
  cycles: [{ verdictId, createdAt: '2026-08-01T00:00:00.000Z' }],
};

const initialEvents = [
  {
    eventId: 'observe-cycle',
    caseId,
    verdictId,
    domainId: root.domainId,
    type: 'verdict_cycle_observed',
    actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
    occurredAt: '2026-08-01T00:01:00.000Z',
    cycleCreatedAt: '2026-08-01T00:00:00.000Z',
    reason: 'canonical actionable cycle observed',
    refs: [ref('verdict', `verdict:${verdictId}`)],
  },
  {
    eventId: 'bind-cycle',
    caseId,
    verdictId,
    domainId: root.domainId,
    type: 'responsibility_bound',
    actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
    occurredAt: '2026-08-01T00:02:00.000Z',
    reason: 'durable task and lease bound',
    refs: [ref('task', 'task:case-cycle'), ref('other', 'lease:case-cycle:1')],
    taskId: 'task-case-cycle',
    leaseId: 'lease-case-cycle',
    leaseGeneration: 1,
  },
];

class MemoryLog {
  events = structuredClone(initialEvents);
  seen = new Set(this.events.map((event) => event.eventId));

  async append(event, expectedSequence) {
    if (this.seen.has(event.eventId)) return { outcome: 'duplicate' };
    if (this.events.length !== expectedSequence) return { outcome: 'conflict', actualSequence: this.events.length };
    this.events.push(structuredClone(event));
    this.seen.add(event.eventId);
    return { outcome: 'appended', sequence: this.events.length - 1 };
  }

  async read(subjectId) {
    return subjectId === caseId ? structuredClone(this.events) : [];
  }
}

function command(type, eventId, expectedSequence, extra = {}) {
  return {
    type,
    eventId,
    verdictId,
    expectedSequence,
    reason: `${type} with durable evidence`,
    refs: [ref('message', `thread:${eventId}`)],
    ...extra,
  };
}

describe('F266 stable case command service', () => {
  let eventLog;
  let service;
  let releaseCalls;

  beforeEach(() => {
    eventLog = new MemoryLog();
    releaseCalls = [];
    service = new ReevalCaseService({
      eventLog,
      loadRoot: async (requestedVerdictId) => (requestedVerdictId === verdictId ? root : undefined),
      releaseTruth: {
        verifyMainLanded(requestedSha) {
          releaseCalls.push(`main:${requestedSha}`);
          if (requestedSha !== commitSha) throw new Error('commit is not landed on origin/main');
          return { commitSha, evidenceRef: `git:origin/main@${'c'.repeat(40)}:contains:${commitSha}` };
        },
        verifyLiveActive(requestedSha) {
          releaseCalls.push(`live:${requestedSha}`);
          if (requestedSha !== commitSha) throw new Error('commit is not active in loaded runtime');
          return { commitSha, evidenceRef: `runtime:${'d'.repeat(40)}:contains:${commitSha}` };
        },
      },
      now: () => '2026-08-01T01:00:00.000Z',
    });
  });

  it('records the ordered main, live, and trusted re-evaluation path', async () => {
    assert.equal(
      (await service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan', 2))).projection.status,
      'action_planned',
    );
    assert.equal(
      (await service.execute({ kind: 'cat', id: 'codex-sol' }, command('record_main_landed', 'main', 3, { commitSha })))
        .projection.status,
      'main_landed',
    );
    assert.equal(
      (await service.execute({ kind: 'cat', id: 'codex-sol' }, command('record_live_active', 'live', 4, { commitSha })))
        .projection.status,
      'live_active',
    );
    const pending = await service.execute({ kind: 'cat', id: 'codex-sol' }, command('request_reeval', 'request', 5));
    assert.equal(pending.projection.status, 'reeval_pending');
    assert.equal(pending.projection.reevalDueAt, '2026-08-08T01:00:00.000Z');
    assert.equal(pending.projection.reevalAssignedCatId, 'gpt52');

    const resolved = await service.execute(
      { kind: 'cat', id: 'gpt52' },
      command('record_reeval_result', 'result', 6, { result: 'passed' }),
    );
    assert.equal(resolved.projection.status, 'resolved');
    assert.deepEqual(releaseCalls, [`main:${commitSha}`, `live:${commitSha}`]);
    assert.match(resolved.projection.actionRefs[1].value, /^git:origin\/main@/);
    assert.match(resolved.projection.actionRefs[3].value, /^runtime:/);
  });

  it('fails fake release claims and illegal ordering before append', async () => {
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan', 2));
    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'codex-sol' },
        command('record_main_landed', 'fake-main', 3, { commitSha: 'e'.repeat(40) }),
      ),
      /not landed/,
    );
    assert.equal(eventLog.events.length, 3);

    await assert.rejects(
      service.execute({ kind: 'cat', id: 'codex-sol' }, command('request_reeval', 'early-reeval', 3)),
      /illegal transition/,
    );
    assert.equal(eventLog.events.length, 3);
  });

  it('rejects caller-authored SLA and pins result authority to the trusted eval cat', async () => {
    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'codex-sol' },
        command('request_reeval', 'spoof-due', 2, { dueAt: '2099-01-01T00:00:00.000Z' }),
      ),
      /invalid case lifecycle command/,
    );

    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan', 2));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('record_main_landed', 'main', 3, { commitSha }));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('record_live_active', 'live', 4, { commitSha }));
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('request_reeval', 'request', 5));

    await assert.rejects(
      service.execute(
        { kind: 'cat', id: 'codex-sol' },
        command('record_reeval_result', 'spoof-result', 6, { result: 'passed' }),
      ),
      /pinned eval cat/,
    );
  });

  it('retries release and SLA events with the originally persisted server facts', async () => {
    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('plan_action', 'plan', 2));
    const mainCommand = command('record_main_landed', 'main', 3, { commitSha });
    await service.execute({ kind: 'cat', id: 'codex-sol' }, mainCommand);
    const duplicateMain = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      { ...mainCommand, expectedSequence: 0 },
    );
    assert.equal(duplicateMain.outcome, 'duplicate');
    assert.deepEqual(releaseCalls, [`main:${commitSha}`]);

    await service.execute({ kind: 'cat', id: 'codex-sol' }, command('record_live_active', 'live', 4, { commitSha }));
    const request = command('request_reeval', 'request', 5);
    await service.execute({ kind: 'cat', id: 'codex-sol' }, request);
    const duplicateRequest = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      { ...request, expectedSequence: 0 },
    );
    assert.equal(duplicateRequest.outcome, 'duplicate');
    assert.equal(duplicateRequest.projection.reevalDueAt, '2026-08-08T01:00:00.000Z');
  });
});
