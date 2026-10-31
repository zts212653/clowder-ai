import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { evalVerdictLifecycleRoutes } from '../../dist/routes/eval-verdict-lifecycle.js';

export const verdictId = 'f266-route-verdict';

class MemoryEventLog {
  events = [];
  seen = new Set();

  async append(event, expectedSequence) {
    if (this.seen.has(event.eventId)) return { outcome: 'duplicate' };
    if (this.events.length !== expectedSequence) return { outcome: 'conflict', actualSequence: this.events.length };
    this.seen.add(event.eventId);
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: this.events.length - 1 };
  }

  async read(id) {
    return id === verdictId ? structuredClone(this.events) : [];
  }

  async listVerdictIds() {
    return this.events.length === 0 ? [] : [verdictId];
  }
}

function setupHarnessRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'f266-lifecycle-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bundles', verdictId), { recursive: true });
  mkdirSync(join(root, 'eval-domains'), { recursive: true });
  writeFileSync(
    join(root, 'bundles', verdictId, 'lifecycle-root.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      verdictId,
      domainId: 'eval:capability-tips',
      createdAt: '2026-07-18T00:00:00.000Z',
      verdict: 'fix',
      harnessUnderEval: { featureId: 'F268', componentId: 'tips', name: 'Capability Tips' },
      ownerAsk: {
        targetFeatureId: 'F268',
        targetOwnerCatId: 'codex-sol',
        requestedAction: 'repair the tips harness',
      },
      acceptanceReevalPlan: {
        nextEvalAt: '2026-07-25T00:00:00.000Z',
        closureCondition: 'the next eval verifies the repair',
      },
    })}\n`,
  );
  writeFileSync(
    join(root, 'eval-domains', 'eval-capability-tips.yaml'),
    `domainId: eval:capability-tips
displayName: Capability Tips Eval
systemThreadId: thread_eval_capability_tips
evalCat:
  catId: registry-eval
  handle: "@registry-eval"
  model: registry-model
frequency: weekly
sourceAdapter: capability-tips-eval
sourceRefsKind: capability-tips-window
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent: [verdict-discussion]
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F268
  ownerCatId: codex-sol
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
fixtures: []
`,
  );
  return root;
}

function invocationRecord(invocationId, catId) {
  return {
    invocationId,
    callbackToken: 'valid-token',
    userId: 'owner-user',
    catId,
    threadId: 'thread_eval_capability_tips',
    clientMessageIds: new Set(),
    createdAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
  };
}

export async function buildApp(t) {
  const app = Fastify({ logger: false });
  const eventLog = new MemoryEventLog();
  const harnessFeedbackRoot = setupHarnessRoot(t);
  const callbackRegistry = {
    async verify(invocationId, token) {
      if (token !== 'valid-token') return { ok: false, reason: 'invalid_token' };
      const catIdByInvocation = {
        'owner-invocation': 'codex-sol',
        'new-owner-invocation': 'opus-47',
        'eval-invocation': 'gpt52',
      };
      const catId = catIdByInvocation[invocationId] ?? 'other-cat';
      return { ok: true, record: invocationRecord(invocationId, catId) };
    },
  };
  const agentKeyRegistry = {
    async verify(secret) {
      if (secret !== 'owner-agent-key') return { ok: false, reason: 'unknown_invocation' };
      return {
        ok: true,
        record: {
          agentKeyId: 'owner-key',
          userId: 'owner-user',
          catId: 'codex-sol',
          scope: 'user-bound',
          secretHash: 'unused',
          salt: 'unused',
          issuedAt: Date.now() - 1_000,
          expiresAt: Date.now() + 60_000,
        },
      };
    },
  };
  app.addHook('preHandler', async (request) => {
    const sessionUserId = request.headers['x-test-session-user'];
    if (typeof sessionUserId === 'string') request.sessionUserId = sessionUserId;
  });
  await app.register(evalVerdictLifecycleRoutes, {
    harnessFeedbackRoot,
    eventLog,
    redis: {
      async get(key) {
        return key.includes('eval:capability-tips')
          ? JSON.stringify({
              catId: 'gpt52',
              handle: '@gpt52',
              model: 'gpt-5.4',
              setAt: '2026-07-18T00:00:00.000Z',
            })
          : null;
      },
    },
    callbackRegistry,
    agentKeyRegistry,
    now: () => '2026-07-18T02:00:00.000Z',
  });
  return { app, eventLog };
}

export async function buildUnavailableApp(t) {
  const app = Fastify({ logger: false });
  const harnessFeedbackRoot = setupHarnessRoot(t);
  await app.register(evalVerdictLifecycleRoutes, { harnessFeedbackRoot });
  return app;
}

export function command(type, expectedSequence, extra = {}) {
  return {
    type,
    eventId: `${type}-${expectedSequence}`,
    expectedSequence,
    reason: `${type} with durable evidence`,
    refs: [{ kind: 'message', availability: 'available', value: `thread:${type}` }],
    ...extra,
  };
}

export function openedEvent() {
  return {
    eventId: `f266:${verdictId}:opened`,
    verdictId,
    domainId: 'eval:capability-tips',
    type: 'verdict_opened',
    actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
    occurredAt: '2026-07-18T00:00:00.000Z',
    reason: 'actionable verdict published with immutable lifecycle root metadata',
    refs: [
      {
        kind: 'verdict',
        availability: 'available',
        value: `docs/harness-feedback/verdicts/${verdictId}.md`,
      },
      {
        kind: 'other',
        availability: 'available',
        value: `docs/harness-feedback/bundles/${verdictId}/lifecycle-root.json`,
      },
    ],
  };
}

export function callbackHeaders(invocationId) {
  return { 'x-invocation-id': invocationId, 'x-callback-token': 'valid-token' };
}

export async function post(app, payload, headers = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/eval-verdicts/${verdictId}/lifecycle-events`,
    headers,
    payload,
  });
}
