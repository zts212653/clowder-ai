import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { EventAuditLog } from '../dist/domains/cats/services/orchestration/EventAuditLog.js';
import { SkillConsumptionReceiptService } from '../dist/domains/cats/services/tool-usage/SkillConsumptionReceiptService.js';
import { registerWorktrees } from '../dist/domains/workspace/workspace-security.js';
import { registerCallbackSkillConsumptionRoutes } from '../dist/routes/callback-skill-consumption-routes.js';
import { workspaceRoutes } from '../dist/routes/workspace.js';

const SCOPE = {
  userId: 'owner-1',
  threadId: 'thread-1',
  invocationId: 'invocation-1',
  catId: 'codex-sol',
};

function createFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-skill-consumption-'));
  const skillDir = join(root, 'workspace-navigator');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# Workspace Navigator\nrevision one\n');
  const events = [];
  const auditLog = {
    async append(input) {
      const event = { id: `receipt-${events.length + 1}`, timestamp: 1_000 + events.length, ...input };
      events.push(event);
      return event;
    },
  };
  const receipts = new SkillConsumptionReceiptService({
    skillSourceRoot: root,
    auditLog,
    secret: Buffer.alloc(32, 7),
    now: options.now ?? (() => 1_000),
    ttlMs: options.ttlMs,
  });
  return { root, skillDir, events, auditLog, receipts };
}

describe('revision-bound skill consumption receipts', () => {
  const cleanups = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()();
  });

  it('keeps preparation distinct from a durable applied/dismissed receipt', async () => {
    const fixture = createFixture();
    cleanups.push(() => rmSync(fixture.root, { recursive: true, force: true }));

    const prepared = await fixture.receipts.prepare('workspace-navigator', SCOPE);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.preparation.state, 'prepared');
    assert.equal(prepared.preparation.skillId, 'workspace-navigator');
    assert.match(prepared.preparation.skillRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(fixture.events.length, 0, 'preparation/presentation is not an applied receipt');

    const recorded = await fixture.receipts.recordApplied({
      handle: prepared.preparation.handle,
      scope: SCOPE,
      outcome: { kind: 'workspace_navigation_delivery.v1', deliveryStatus: 'queued' },
    });
    assert.equal(recorded.ok, true);
    assert.deepEqual(recorded.receipt, {
      v: 1,
      receiptId: 'receipt-1',
      skillId: 'workspace-navigator',
      skillRevision: prepared.preparation.skillRevision,
      consumerId: 'workspace-navigator.navigate.v1',
      invocationId: SCOPE.invocationId,
      threadId: SCOPE.threadId,
      catId: SCOPE.catId,
      consumption: 'applied',
      outcome: { kind: 'workspace_navigation_delivery.v1', deliveryStatus: 'queued' },
      occurredAt: 1_000,
      applicabilityAtWrite: 'current',
    });
    assert.equal(fixture.events.length, 1);
    assert.equal(fixture.events[0].type, 'skill_consumption_receipt');
    assert.equal(JSON.stringify(fixture.events[0]).includes('revision one'), false);

    const replay = await fixture.receipts.recordApplied({
      handle: prepared.preparation.handle,
      scope: SCOPE,
      outcome: { kind: 'workspace_navigation_delivery.v1', deliveryStatus: 'applied' },
    });
    assert.deepEqual(replay, { ok: false, reason: 'already_consumed' });
  });

  it('binds a handle to the exact invocation, consumer, and current package revision', async () => {
    const fixture = createFixture();
    cleanups.push(() => rmSync(fixture.root, { recursive: true, force: true }));
    const prepared = await fixture.receipts.prepare('workspace-navigator', SCOPE);
    assert.equal(prepared.ok, true);

    const crossInvocation = await fixture.receipts.verifyPrepared(
      prepared.preparation.handle,
      { ...SCOPE, invocationId: 'invocation-other' },
      'workspace-navigator.navigate.v1',
    );
    assert.deepEqual(crossInvocation, { ok: false, reason: 'scope_mismatch' });

    const wrongConsumer = await fixture.receipts.verifyPrepared(
      prepared.preparation.handle,
      SCOPE,
      'workspace-navigator.preview.v1',
    );
    assert.deepEqual(wrongConsumer, { ok: false, reason: 'consumer_mismatch' });

    writeFileSync(join(fixture.skillDir, 'consumer-notes.md'), 'package-level correction\n');
    const stale = await fixture.receipts.verifyPrepared(
      prepared.preparation.handle,
      SCOPE,
      'workspace-navigator.navigate.v1',
    );
    assert.deepEqual(stale, { ok: false, reason: 'source_revision_changed' });
  });

  it('expires an unconsumed preparation instead of inferring a receipt from prior presentation', async () => {
    let now = 1_000;
    const fixture = createFixture({ now: () => now, ttlMs: 50 });
    cleanups.push(() => rmSync(fixture.root, { recursive: true, force: true }));
    const prepared = await fixture.receipts.prepare('workspace-navigator', SCOPE);
    assert.equal(prepared.ok, true);
    assert.equal(fixture.events.length, 0);

    now = 1_050;
    const expired = await fixture.receipts.recordDismissed({
      handle: prepared.preparation.handle,
      scope: SCOPE,
      reason: 'outside_skill_scope',
    });
    assert.deepEqual(expired, { ok: false, reason: 'expired' });
    assert.equal(fixture.events.length, 0);
  });

  it('classifies a recorded receipt as stale after a correction changes the package revision', async () => {
    const fixture = createFixture();
    cleanups.push(() => rmSync(fixture.root, { recursive: true, force: true }));
    const prepared = await fixture.receipts.prepare('workspace-navigator', SCOPE);
    assert.equal(prepared.ok, true);
    const recorded = await fixture.receipts.recordDismissed({
      handle: prepared.preparation.handle,
      scope: SCOPE,
      reason: 'outside_skill_scope',
    });
    assert.equal(recorded.ok, true);
    assert.deepEqual(recorded.receipt.outcome, {
      kind: 'workspace_navigation_applicability.v1',
      decision: 'not_applicable',
      reason: 'outside_skill_scope',
    });
    assert.equal(await fixture.receipts.classifyApplicability(recorded.receipt), 'current');

    writeFileSync(join(fixture.skillDir, 'SKILL.md'), '# Workspace Navigator\ncorrected package\n');
    assert.equal(await fixture.receipts.classifyApplicability(recorded.receipt), 'stale');
  });

  it('prepares and dismisses only through invocation auth; agent-key is explicitly unsupported', async () => {
    const fixture = createFixture();
    cleanups.push(() => rmSync(fixture.root, { recursive: true, force: true }));
    const app = Fastify({ logger: false });
    app.decorateRequest('callbackAuth', undefined);
    app.decorateRequest('callbackPrincipal', undefined);
    app.addHook('preHandler', async (request) => {
      if (request.headers['x-test-agent-key'] === 'true') {
        request.callbackPrincipal = {
          kind: 'agent_key',
          agentKeyId: 'agent-key-1',
          userId: SCOPE.userId,
          catId: SCOPE.catId,
          scope: 'user-bound',
        };
        return;
      }
      request.callbackAuth = {
        invocationId: SCOPE.invocationId,
        callbackToken: 'callback-token',
        catId: SCOPE.catId,
        threadId: SCOPE.threadId,
        userId: SCOPE.userId,
        clientMessageIds: new Set(),
        createdAt: 0,
        expiresAt: 10_000,
      };
      request.callbackPrincipal = { kind: 'invocation', ...SCOPE };
    });
    registerCallbackSkillConsumptionRoutes(app, { receipts: fixture.receipts });
    await app.ready();
    cleanups.push(() => app.close());

    const prepare = await app.inject({
      method: 'POST',
      url: '/api/callbacks/skill-consumption/prepare',
      payload: { skillId: 'workspace-navigator' },
    });
    assert.equal(prepare.statusCode, 200);
    assert.equal(prepare.json().state, 'prepared');

    const dismissed = await app.inject({
      method: 'POST',
      url: '/api/callbacks/skill-consumption/dismiss',
      payload: { handle: prepare.json().handle, reason: 'outside_skill_scope' },
    });
    assert.equal(dismissed.statusCode, 200);
    assert.equal(dismissed.json().receipt.consumption, 'dismissed');

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/callbacks/skill-consumption/prepare',
      headers: { 'x-test-agent-key': 'true' },
      payload: { skillId: 'workspace-navigator' },
    });
    assert.equal(unsupported.statusCode, 409);
    assert.deepEqual(unsupported.json(), {
      error: 'carrier_unsupported',
      reason: 'same_invocation_receipt_requires_invocation_auth',
    });
  });

  it('records applied only inside the real Workspace consumer and rejects unsupported carriers before navigation', async () => {
    const fixture = createFixture();
    cleanups.push(() => rmSync(fixture.root, { recursive: true, force: true }));
    const app = Fastify({ logger: false });
    const repoRoot = resolve(import.meta.dirname, '../../..');
    registerWorktrees([{ id: 'skill-receipt-wt', root: repoRoot, branch: 'main', head: 'abc123' }]);
    const emitted = [];
    const auditLog = new EventAuditLog({ auditDir: join(fixture.root, 'workspace-audit') });
    auditLog.append = fixture.auditLog.append;
    await app.register(workspaceRoutes, {
      auditLog,
      skillConsumptionReceipts: fixture.receipts,
      socketEmit: (event, data, room) => emitted.push({ event, data, room }),
      callbackRegistry: {
        verify: async (invocationId, callbackToken) =>
          invocationId === SCOPE.invocationId && callbackToken === 'callback-token'
            ? {
                ok: true,
                record: {
                  invocationId,
                  callbackToken,
                  threadId: SCOPE.threadId,
                  userId: SCOPE.userId,
                  catId: SCOPE.catId,
                  clientMessageIds: new Set(),
                  createdAt: 0,
                  expiresAt: 10_000,
                },
              }
            : { ok: false, reason: 'invalid_token' },
      },
      agentKeyRegistry: {
        verify: async () => ({
          ok: true,
          record: {
            agentKeyId: 'agent-key-1',
            catId: SCOPE.catId,
            userId: SCOPE.userId,
            secretHash: 'hash',
            salt: 'salt',
            scope: 'user-bound',
            issuedAt: 0,
            expiresAt: 10_000,
          },
        }),
      },
      threadStore: {
        async get() {
          return { id: SCOPE.threadId, createdBy: SCOPE.userId };
        },
        async list() {
          return [];
        },
      },
    });
    await app.ready();
    cleanups.push(() => app.close());

    const prepared = await fixture.receipts.prepare('workspace-navigator', SCOPE);
    assert.equal(prepared.ok, true);
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      headers: {
        'x-invocation-id': SCOPE.invocationId,
        'x-callback-token': 'callback-token',
      },
      payload: {
        path: join(repoRoot, 'package.json'),
        action: 'open',
        skillConsumptionHandle: prepared.preparation.handle,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().skillConsumptionReceipt.consumption, 'applied');
    assert.equal(response.json().skillConsumptionReceipt.outcome.deliveryStatus, 'unconfirmed');
    assert.equal(emitted.length, 2);

    const preparedForCrossThread = await fixture.receipts.prepare('workspace-navigator', SCOPE);
    assert.equal(preparedForCrossThread.ok, true);
    const emittedBeforeCrossThread = emitted.length;
    const crossThread = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      headers: {
        'x-invocation-id': SCOPE.invocationId,
        'x-callback-token': 'callback-token',
      },
      payload: {
        path: join(repoRoot, 'package.json'),
        action: 'open',
        threadId: 'thread-other',
        skillConsumptionHandle: preparedForCrossThread.preparation.handle,
      },
    });
    assert.equal(crossThread.statusCode, 409);
    assert.deepEqual(crossThread.json(), { error: 'scope_mismatch' });
    assert.equal(emitted.length, emittedBeforeCrossThread, 'scope mismatch must fail before Workspace delivery');

    const preparedForReveal = await fixture.receipts.prepare('workspace-navigator', SCOPE);
    assert.equal(preparedForReveal.ok, true);
    const emittedBeforeReveal = emitted.length;
    const wrongConsumerAction = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      headers: {
        'x-invocation-id': SCOPE.invocationId,
        'x-callback-token': 'callback-token',
      },
      payload: {
        path: join(repoRoot, 'package.json'),
        action: 'reveal',
        skillConsumptionHandle: preparedForReveal.preparation.handle,
      },
    });
    assert.equal(wrongConsumerAction.statusCode, 409);
    assert.deepEqual(wrongConsumerAction.json(), { error: 'consumer_mismatch' });
    assert.equal(emitted.length, emittedBeforeReveal);

    const oversizedHandle = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      headers: {
        'x-invocation-id': SCOPE.invocationId,
        'x-callback-token': 'callback-token',
      },
      payload: {
        path: join(repoRoot, 'package.json'),
        action: 'open',
        skillConsumptionHandle: 'x'.repeat(2_001),
      },
    });
    assert.equal(oversizedHandle.statusCode, 400);
    assert.match(oversizedHandle.json().error, /at most 2000/);
    assert.equal(emitted.length, emittedBeforeReveal);

    const preparedForAgentKey = await fixture.receipts.prepare('workspace-navigator', SCOPE);
    assert.equal(preparedForAgentKey.ok, true);
    const emittedBefore = emitted.length;
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      headers: { 'x-agent-key-secret': 'agent-key-secret' },
      payload: {
        path: join(repoRoot, 'package.json'),
        action: 'open',
        threadId: SCOPE.threadId,
        skillConsumptionHandle: preparedForAgentKey.preparation.handle,
      },
    });
    assert.equal(unsupported.statusCode, 409);
    assert.deepEqual(unsupported.json(), {
      error: 'carrier_unsupported',
      reason: 'same_invocation_receipt_requires_invocation_auth',
    });
    assert.equal(emitted.length, emittedBefore);
  });
});
