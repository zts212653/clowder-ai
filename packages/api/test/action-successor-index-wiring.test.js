import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const callbacksSource = readFileSync(new URL('../src/routes/callbacks.ts', import.meta.url), 'utf8');
const localReviewRouteSource = readFileSync(
  new URL('../src/routes/callback-local-review-verdict-route.ts', import.meta.url),
  'utf8',
);
const localReviewBootstrapUrl = new URL(
  '../src/domains/ball-custody/LocalReviewCompletionBootstrap.ts',
  import.meta.url,
);

function block(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

describe('F167 successor runtime wiring', () => {
  it('injects ActionSuccessorAdmissionService into callbacksRoutes, the live action carrier owner', () => {
    const callbackOpts = block('const callbackOpts = {', 'await app.register(callbacksRoutes, callbackOpts);');
    assert.match(
      callbackOpts,
      /actionSuccessorAdmissionService/,
      'callbackOpts must receive the constructed admission service or every structured carrier returns action_fence_unavailable',
    );
  });

  it('does not pretend messagesRoutes consumes ActionSuccessorAdmissionService', () => {
    const messagesOpts = block('const messagesOpts = {', 'await app.register(messagesRoutes, messagesOpts);');
    assert.doesNotMatch(
      messagesOpts,
      /actionSuccessorAdmissionService/,
      'messagesOpts is not the callback carrier DI boundary; pseudo-wiring here hid the live omission',
    );
  });

  it('boot-asserts the admitted predicate capability and wires both producer ports non-optionally', () => {
    const verdictWiring = block('let externalReviewVerdictService:', 'const callbackOpts = {');
    assert.match(verdictWiring, /assertActionTerminalCapabilityRegistryReady\(/);
    assert.match(verdictWiring, /action_successor_preflight: preflightActionLease/);
    assert.match(verdictWiring, /action_successor_completion: completeActionLease/);
    assert.match(verdictWiring, /preflightLease: preflightActionLease/);
    assert.match(verdictWiring, /completeActionLease,/);
    assert.match(verdictWiring, /local_review_verdict/);
    assert.doesNotMatch(verdictWiring, /\.\.\.\(actionSuccessor(?:LeaseStore|CompletionService)/);
  });

  it('keeps local-review construction in a focused bootstrap module', () => {
    assert.equal(existsSync(localReviewBootstrapUrl), true, 'focused local-review bootstrap module must exist');
    const bootstrapSource = readFileSync(localReviewBootstrapUrl, 'utf8');
    assert.ok(bootstrapSource.split('\n').length <= 350, 'focused bootstrap module must remain below hard limit');
    assert.match(source, /createLocalReviewCompletionBootstrap\(/);
    assert.doesNotMatch(source, /new localReview(?:Evidence|Verdict)Mod\./);
    assert.match(bootstrapSource, /new MessageStoreLocalReviewEvidenceProvider\(/);
    assert.match(bootstrapSource, /new LocalReviewVerdictService\(/);
  });

  it('keeps the local review callback in a focused route module', () => {
    assert.match(callbacksSource, /registerCallbackLocalReviewVerdictRoute/);
    assert.doesNotMatch(callbacksSource, /app\.post\('\/api\/callbacks\/record-local-review-verdict'/);
    assert.match(localReviewRouteSource, /app\.post\('\/api\/callbacks\/record-local-review-verdict'/);
    assert.match(localReviewRouteSource, /app\.post\('\/api\/callbacks\/recover-local-review-verdict'/);
    assert.match(localReviewRouteSource, /resolveActionSuccessorCarrier/);
    assert.ok(localReviewRouteSource.split('\n').length <= 350, 'focused callback module must remain below hard limit');
  });

  it('reconciles pending return carriers at boot and periodically through the existing queue', () => {
    const queueWiring = block('const invocationQueue = new InvocationQueue();', 'const onReconciledZombie =');
    assert.match(queueWiring, /new ActionSuccessorRecoverySweep\(/);
    assert.match(queueWiring, /idempotencyKey: carrier\.idempotencyKey/);
    assert.match(queueWiring, /actionSuccessorFence: carrier\.fence/);
    assert.match(queueWiring, /actionSuccessorInvocationIdempotencyKey\(carrier\.idempotencyKey\)/);
    assert.match(queueWiring, /invocationRecordStore\.getByIdempotencyKey\(/);
    assert.match(queueWiring, /classifyInvocationRecoveryStatus\(/);
    assert.match(queueWiring, /outcome: 'completed'/);
    assert.doesNotMatch(queueWiring, /outcome: 'durable'/);
    assert.match(queueWiring, /runActionSuccessorRecovery\(\)/);
    assert.match(queueWiring, /setInterval\(runActionSuccessorRecovery, 30_000\)/);
  });

  it('admits the exact approved carrier into durable Queue custody before reporting delivery', () => {
    const deliveryWiring = block(
      'const deliverApprovedActionCarrier = async (',
      'if (actionSuccessorLeaseStore && actionSubjectTruthResolver) {',
    );
    assert.match(deliveryWiring, /deliveryStatus: 'queued'/);
    assert.match(deliveryWiring, /classifyApprovedActionCarrier\(proposal, storedMsg\)/);
    assert.match(deliveryWiring, /classifyApprovedActionCarrier\(proposal, admittedMessage\)/);
    const custodyProof = deliveryWiring.indexOf("if (admittedState.outcome !== 'admitted')");
    const visibleBroadcast = deliveryWiring.indexOf('actionSocketManager.broadcastAgentMessage(');
    const deliverySuccess = deliveryWiring.lastIndexOf(
      "return { outcome: 'enqueued', deliveredMessageId: storedMsg.id }",
    );
    assert.ok(custodyProof >= 0 && custodyProof < visibleBroadcast);
    assert.ok(visibleBroadcast < deliverySuccess);
  });

  it('revalidates frozen dispatch truth through the canonical resolver before recovery delivery', () => {
    const recoveryWiring = block(
      'if (actionSuccessorLeaseStore && actionSubjectTruthResolver) {',
      'const onReconciledZombie =',
    );
    assert.match(recoveryWiring, /dispatch:\s*{[\s\S]*truthResolver: actionSubjectTruthResolver/);
    assert.match(recoveryWiring, /deliver: deliverApprovedActionCarrier/);
  });
});
