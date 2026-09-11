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
    assert.match(queue, /entry\.execution\.freshnessClosureId/);
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

  it('retires post-message freshness/HELD side effects while preserving output truth refinement', () => {
    const callbacks = source('routes/callbacks.ts');
    const refiner = source('domains/cats/services/freshness/glass-box/FreshnessOutputRefiner.ts');
    assert.doesNotMatch(callbacks, /checkFreshnessForPostMessage/);
    assert.doesNotMatch(callbacks, /acknowledgeHeld/);
    assert.doesNotMatch(callbacks, /markQueuedNotified/);
    assert.match(refiner, /freshness\.reason === 'queued_messages'/);
    assert.match(refiner, /return committedDecision/);
  });

  it('keeps the single durable Queue ledger wired across append, execution, read, and startup', () => {
    const index = source('index.ts');
    const messages = source('routes/messages.ts');

    assert.match(messages, /appendAndEnqueueDurable/);
    assert.match(index, /new RedisQueueLedgerStore\(redis\)/);
    assert.match(index, /new InvocationQueue\([\s\S]*?RedisQueueLedgerStore/);
    assert.match(index, /await invocationQueue\.hydrateFromLedger\(messageStore\)/);
    const ledgerHydration = index.indexOf('await invocationQueue.hydrateFromLedger(messageStore)');
    const queueRecovery = index.indexOf('const startupRecovery = await reconciler.reconcileOrphans()');
    const callbackAdmission = index.indexOf('registry.markStartupRecoveryComplete()');
    const queueResume = index.indexOf('for (const scope of startupRecovery.queueResumeScopes)');
    assert.ok(ledgerHydration >= 0, 'production bootstrap must hydrate the durable Queue ledger');
    assert.ok(queueRecovery > ledgerHydration, 'orphan reconciliation must see the hydrated Queue ledger');
    assert.ok(callbackAdmission > queueRecovery, 'callback admission must wait for Queue restart convergence');
    assert.ok(queueResume > callbackAdmission, 'restored Queue work must resume only after callback admission opens');
    assert.match(
      index.slice(queueResume),
      /queueProcessor\.requestDrain\(scope\.threadId\)/,
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
