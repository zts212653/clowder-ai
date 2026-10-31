import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { EvalReleaseTruthError } from '../../dist/infrastructure/harness-eval/eval-release-truth-resolver.js';
import { evalVerdictLifecycleRoutes } from '../../dist/routes/eval-verdict-lifecycle.js';

const verdictId = 'capability-wakeup-2026-08-01-rich-messaging';
const caseId = `eval-case-v1-${'a'.repeat(64)}`;
const commitSha = 'b'.repeat(40);
const ref = (kind, value) => ({ kind, availability: 'available', value });

class MemoryEventLog {
  events = [
    {
      eventId: 'observe',
      caseId,
      verdictId,
      domainId: 'eval:capability-wakeup',
      type: 'verdict_cycle_observed',
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      occurredAt: '2026-08-01T00:01:00.000Z',
      cycleCreatedAt: '2026-08-01T00:00:00.000Z',
      reason: 'cycle observed',
      refs: [ref('verdict', `verdict:${verdictId}`)],
    },
    {
      eventId: 'bound',
      caseId,
      verdictId,
      domainId: 'eval:capability-wakeup',
      type: 'responsibility_bound',
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      occurredAt: '2026-08-01T00:02:00.000Z',
      reason: 'responsibility bound',
      refs: [ref('task', 'task:case-cycle'), ref('other', 'lease:case-cycle:1')],
      taskId: 'task-case-cycle',
      leaseId: 'lease-case-cycle',
      leaseGeneration: 1,
    },
  ];
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

  async listVerdictIds() {
    return [caseId];
  }

  async listSubjectIds() {
    return [caseId];
  }
}

function setupRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'f266-case-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bundles', verdictId), { recursive: true });
  mkdirSync(join(root, 'eval-domains'), { recursive: true });
  writeFileSync(
    join(root, 'bundles', verdictId, 'lifecycle-root.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      caseId,
      findingKey: 'rich-messaging',
      verdictId,
      domainId: 'eval:capability-wakeup',
      createdAt: '2026-08-01T00:00:00.000Z',
      verdict: 'fix',
      harnessUnderEval: { featureId: 'F266', componentId: 'rich-messaging', name: 'Rich messaging' },
      ownerAsk: {
        targetFeatureId: 'F266',
        targetOwnerCatId: 'codex-sol',
        requestedAction: 'repair the actionable finding',
      },
      acceptanceReevalPlan: {
        nextEvalAt: '2026-08-08T00:00:00.000Z',
        closureCondition: 'fresh run passes',
      },
    })}\n`,
  );
  writeFileSync(
    join(root, 'eval-domains', 'eval-capability-wakeup.yaml'),
    `domainId: eval:capability-wakeup
displayName: Capability Wakeup
systemThreadId: thread_eval_capability_wakeup
evalCat: { catId: gpt52, handle: "@gpt52", model: gpt-5.4 }
frequency: weekly
sourceAdapter: capability-wakeup
sourceRefsKind: capability-wakeup-window
threadPolicy: { role: working-home, stateSot: registry, allowedContent: [verdict-discussion] }
legacyScheduledTaskIds: []
handoffTargetResolver: { featureId: F266, ownerCatId: codex-sol, threadLookup: feature-thread }
sla: { acknowledgeHours: 48, reevalWithinHours: 168 }
fixtures: []
`,
  );
  return root;
}

function command(type, expectedSequence, extra = {}) {
  return {
    type,
    eventId: `${type}-${expectedSequence}`,
    expectedSequence,
    reason: `${type} with durable evidence`,
    refs: [ref('message', `thread:${type}`)],
    ...extra,
  };
}

async function buildApp(t) {
  const app = Fastify({ logger: false });
  const eventLog = new MemoryEventLog();
  await app.register(evalVerdictLifecycleRoutes, {
    harnessFeedbackRoot: setupRoot(t),
    eventLog,
    callbackRegistry: {
      async verify(invocationId, token) {
        if (token !== 'valid') return { ok: false, reason: 'invalid_token' };
        const catId = invocationId === 'eval' ? 'gpt52' : 'codex-sol';
        return {
          ok: true,
          record: {
            invocationId,
            callbackToken: token,
            userId: 'owner-user',
            catId,
            threadId: 'thread_f266',
            clientMessageIds: new Set(),
            createdAt: Date.now() - 1_000,
            expiresAt: Date.now() + 60_000,
          },
        };
      },
    },
    releaseTruth: {
      verifyMainLanded(requested) {
        if (requested !== commitSha) throw new EvalReleaseTruthError('main_not_landed', 'not on main');
        return { commitSha, evidenceRef: `git:origin/main@${'c'.repeat(40)}:contains:${commitSha}` };
      },
      verifyLiveActive(requested) {
        if (requested !== commitSha) throw new Error('not live');
        return { commitSha, evidenceRef: `runtime:${'d'.repeat(40)}:contains:${commitSha}` };
      },
    },
    now: () => '2026-08-01T01:00:00.000Z',
  });
  return { app, eventLog };
}

async function post(app, payload, invocationId = 'owner') {
  return app.inject({
    method: 'POST',
    url: `/api/eval-verdicts/${verdictId}/lifecycle-events`,
    headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'valid' },
    payload,
  });
}

describe('F266 case lifecycle route', () => {
  it('dispatches v2 roots to the stable case service with server-owned release evidence', async (t) => {
    const { app, eventLog } = await buildApp(t);
    assert.equal((await post(app, command('plan_action', 2))).statusCode, 200);
    assert.equal((await post(app, command('record_main_landed', 3, { commitSha }))).statusCode, 200);
    assert.equal((await post(app, command('record_live_active', 4, { commitSha }))).statusCode, 200);
    assert.equal((await post(app, command('request_reeval', 5))).statusCode, 200);
    const resolved = await post(app, command('record_reeval_result', 6, { result: 'passed' }), 'eval');
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(resolved.json().projection.status, 'resolved');
    assert.match(eventLog.events.find((event) => event.type === 'main_landed').refs.at(-1).value, /^git:/);
    assert.match(eventLog.events.find((event) => event.type === 'live_active').refs.at(-1).value, /^runtime:/);
    await app.close();
  });

  it('rejects caller-authored deadline and unverified release claims', async (t) => {
    const { app, eventLog } = await buildApp(t);
    assert.equal(
      (await post(app, command('request_reeval', 2, { dueAt: '2099-01-01T00:00:00.000Z' }))).statusCode,
      400,
    );
    assert.equal((await post(app, command('plan_action', 2))).statusCode, 200);
    const fake = await post(app, command('record_main_landed', 3, { commitSha: 'e'.repeat(40) }));
    assert.equal(fake.statusCode, 409);
    assert.equal(fake.json().error, 'main_not_landed');
    assert.match(fake.json().detail, /not on main/);
    assert.equal(eventLog.events.length, 3);
    await app.close();
  });
});
