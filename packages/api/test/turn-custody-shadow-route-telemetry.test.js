/**
 * F167 Phase T — live route-to-span evidence contract.
 *
 * Eval extraction tests can only prove that a fabricated event is readable.
 * This suite executes routeSerial with a real OTel provider so an emitter
 * condition/name/attribute regression cannot silently erase live residual rows.
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { runTurnCustodyRoute, turnCustodyTriggerMessage } from './helpers/turn-custody-route-harness.js';

const { InMemorySpanExporter, SimpleSpanProcessor, NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');
const { RedactingSpanProcessor } = await import('../dist/infrastructure/telemetry/redactor.js');
const { hmacId } = await import('../dist/infrastructure/telemetry/hmac.js');

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new RedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
});
provider.register();

after(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

function sampleEvent(name) {
  const spans = exporter.getFinishedSpans().filter((span) => span.name === 'cat_cafe.a2a.turn_custody_shadow_sample');
  assert.equal(spans.length, 1, `expected one sample span, got ${spans.map((span) => span.name).join(', ')}`);
  const events = spans[0].events.filter((event) => event.name === name);
  assert.equal(events.length, 1, `expected one ${name} event`);
  return events[0];
}

function assertRedactedIds(attributes, raw) {
  assert.equal(attributes.messageId, hmacId(raw.messageId));
  assert.equal(attributes.threadId, hmacId(raw.threadId));
  assert.equal(attributes.invocationId, hmacId(raw.invocationId));
  assert.notEqual(attributes.messageId, raw.messageId);
  assert.notEqual(attributes.threadId, raw.threadId);
  assert.notEqual(attributes.invocationId, raw.invocationId);
}

describe('F167 Phase T route shadow telemetry', () => {
  test('emits a redacted bounded sample for unknown_legacy + agree_block', async () => {
    const threadId = 'raw-thread-agree-block';
    const messageId = 'raw-message-agree-block';
    await runTurnCustodyRoute({
      output: ['ordinary answer without an outlet', '@co-creator'],
      triggerMessage: turnCustodyTriggerMessage(messageId, threadId, 'investigate'),
      wake: { kind: 'legacy', reason: 'carrier_missing', sourceCategory: 'review' },
      projection: {
        state: 'unknown_legacy',
        shouldBlock: true,
        transitionObserved: false,
        evidenceRefs: ['unknown:dispatch_handoff_missing'],
      },
    });

    const event = sampleEvent('turn_custody.unknown_legacy_agree_block');
    const attributes = event.attributes ?? {};
    assertRedactedIds(attributes, { messageId, threadId, invocationId: 'outer-inv-1' });
    assert.deepEqual(
      {
        trigger: attributes.trigger,
        projectionState: attributes.projectionState,
        closeCheckpoint: attributes.closeCheckpoint,
        wakeProvenance: attributes.wakeProvenance,
        transitionObserved: attributes.transitionObserved,
        projectionReason: attributes.projectionReason,
        sourceCategory: attributes.sourceCategory,
        sourceSemantic: attributes.sourceSemantic,
      },
      {
        trigger: 'agree_block',
        projectionState: 'unknown_legacy',
        closeCheckpoint: 'route_settled',
        wakeProvenance: 'legacy:carrier_missing',
        transitionObserved: 'false',
        projectionReason: 'dispatch_handoff_missing',
        sourceCategory: 'review',
        sourceSemantic: 'cross_thread_investigate',
      },
    );
  });

  test('keeps disagreement emission with the added bounded fields', async () => {
    const threadId = 'raw-thread-new-only';
    const messageId = 'raw-message-new-only';
    await runTurnCustodyRoute({
      output: ['@co-creator'],
      triggerMessage: turnCustodyTriggerMessage(messageId, threadId, 'fyi'),
      wake: {
        kind: 'action_successor',
        leaseId: 'lease-1',
        generation: 1,
        holderCatId: 'codex',
      },
      projection: {
        state: 'covered_active',
        shouldBlock: true,
        transitionObserved: false,
        evidenceRefs: ['action:lease-1:g1:codex'],
      },
    });

    const event = sampleEvent('turn_custody.shadow_disagreement');
    const attributes = event.attributes ?? {};
    assertRedactedIds(attributes, { messageId, threadId, invocationId: 'outer-inv-1' });
    assert.deepEqual(
      {
        trigger: attributes.trigger,
        projectionState: attributes.projectionState,
        closeCheckpoint: attributes.closeCheckpoint,
        wakeProvenance: attributes.wakeProvenance,
        transitionObserved: attributes.transitionObserved,
        projectionReason: attributes.projectionReason,
        sourceCategory: attributes.sourceCategory,
        sourceSemantic: attributes.sourceSemantic,
      },
      {
        trigger: 'new_only_block',
        projectionState: 'covered_active',
        closeCheckpoint: 'route_settled',
        wakeProvenance: 'action_successor',
        transitionObserved: 'false',
        projectionReason: 'not_applicable',
        sourceCategory: 'action_successor',
        sourceSemantic: 'cross_thread_fyi',
      },
    );
  });
});
