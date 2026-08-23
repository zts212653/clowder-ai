import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

function source(relativePath) {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

describe('F254 Phase E production wiring guard', () => {
  it('keeps the closure store and atomic output coordinator wired into production bootstrap', () => {
    const index = source('index.ts');
    assert.match(index, /new RedisFreshnessClosureStore\(redis\)/);
    assert.match(index, /new FreshnessOutputCommitCoordinator/);
    assert.match(index, /reconcileFreshnessClosuresAtStartup/);
  });

  it('keeps serial and parallel answer exits behind the same commit coordinator', () => {
    const serial = source('domains/cats/services/agents/routing/route-serial.ts');
    const parallel = source('domains/cats/services/agents/routing/route-parallel.ts');
    assert.match(serial, /freshnessOutputCommitCoordinator\.commit/);
    assert.match(parallel, /freshnessOutputCommitCoordinator\.commit/);
    assert.match(parallel, /parallelBatchId/);
  });

  it('keeps typed successor adoption and connector commit projection wired', () => {
    const queue = source('domains/cats/services/agents/invocation/QueueProcessor.ts');
    const connector = source('infrastructure/connectors/StreamingOutboundHook.ts');
    assert.match(queue, /entry\.freshnessClosureId/);
    assert.match(queue, /claimAttempt/);
    assert.match(connector, /onClosureCatchingUp/);
    assert.match(connector, /onClosureBlocked/);
  });

  it('keeps the successor seen-cursor seed wired (ADR-041 §5: injection counts as seen)', () => {
    // Without this seed the successor re-reads a frozen cursor at output commit and
    // supersedes every replacement forever (2026-07-11 silent message loss).
    const queue = source('domains/cats/services/agents/invocation/QueueProcessor.ts');
    const index = source('index.ts');
    assert.match(queue, /deliveryCursorStore\.ackSeenCursor/);
    assert.match(index, /const queueProcessor = new QueueProcessor\({[\s\S]*?deliveryCursorStore,[\s\S]*?}\)/);
  });

  it('keeps replayable closure truth connected to the eval surface', () => {
    const adapter = source('infrastructure/harness-eval/freshness/freshness-closure-eval-adapter.ts');
    assert.match(adapter, /listUpdatedBetween/);
    assert.match(adapter, /custodyGapCount/);
    assert.match(adapter, /redundantCommittedAttemptCount/);
  });

  it('keeps ordinary queued messages single-owned while freshness only projects notice state', () => {
    const callbacks = source('routes/callbacks.ts');
    const refiner = source('domains/cats/services/freshness/glass-box/FreshnessOutputRefiner.ts');
    assert.match(callbacks, /notice && opts\.invocationQueue/);
    assert.match(callbacks, /markQueuedNotified/);
    assert.match(callbacks, /queued_notified/);
    assert.match(refiner, /freshness\.reason === 'queued_messages'/);
    assert.match(refiner, /return committedDecision/);
  });

  it('keeps restart-durable queued-message custody wired across append, execution, read, and startup', () => {
    const index = source('index.ts');
    const messages = source('routes/messages.ts');

    assert.match(messages, /queueCustody:\s*createInitialQueuedMessageCustody\(enqueueResult\.entry\)/);
    assert.match(index, /const queueCustodyCoordinator = new QueuedMessageCustodyCoordinator\(\{ messageStore \}\)/);
    assert.match(index, /const queueProcessor = new QueueProcessor\(\{[\s\S]*?queueCustodyCoordinator,[\s\S]*?\}\)/);
    assert.match(index, /await app\.register\(queueRoutes, \{[\s\S]*?queueCustodyCoordinator,[\s\S]*?\}\)/);
    assert.match(index, /const callbackOpts = \{[\s\S]*?queueCustodyCoordinator,[\s\S]*?\} as Parameters/);
    assert.match(
      index,
      /new StartupReconciler\(\{[\s\S]*?invocationQueue,[\s\S]*?a2aDispatchDispositionService[\s\S]*?resumePrestartRetirement:\s*\(entries\) => queueProcessor\.resumeDurablePrestartRetirement\(entries\)/,
    );
    const queueRecovery = index.indexOf('const startupRecovery = await reconciler.reconcileOrphans()');
    const callbackAdmission = index.indexOf('registry.markStartupRecoveryComplete()');
    const queueResume = index.indexOf('for (const scope of startupRecovery.queueResumeScopes)');
    assert.ok(queueRecovery >= 0, 'production bootstrap must reconcile durable Queue custody');
    assert.ok(callbackAdmission > queueRecovery, 'callback admission must wait for Queue restart convergence');
    assert.ok(queueResume > callbackAdmission, 'restored Queue work must resume only after callback admission opens');
    assert.match(
      index.slice(queueResume),
      /queueProcessor\.processNext\(scope\.threadId, scope\.userId\)/,
      'restored Queue scopes must re-enter the canonical QueueProcessor',
    );
  });

  it('keeps AC-E9 live replay wired into both on-demand and scheduled verdict publication', () => {
    const index = source('index.ts');

    assert.match(index, /new FreshnessReplayProviderImpl\(\{/);
    assert.match(index, /verdictGenerators\['eval:freshness'\] = createFreshnessGeneratorAdapter/);
    assert.match(index, /fixtureRoot:\s*resolve\(repoRoot, 'docs', 'harness-feedback', 'fixtures', 'f254'\)/);
    assert.match(index, /if \(freshnessClosureStore\) \{\s*wiredPublishDomains\.add\('eval:freshness'\);\s*\}/);
  });
});
