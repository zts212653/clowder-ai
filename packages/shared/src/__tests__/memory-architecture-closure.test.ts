import { describe, expect, it } from 'vitest';
import { memoryRecallFrameV0Schema, memorySurfaceClosureV1Schema } from '../types/memory-architecture-closure.js';

const implemented = {
  state: 'implemented' as const,
  summary: 'Bound to canonical owner evidence.',
  evidenceLevel: 'main' as const,
  evidenceRefs: ['docs/features/F287-memory-cue-plane.md'],
};

const closure = {
  v: 1 as const,
  surfaceId: 'taste',
  declarationRevision: 'taste-closure-v1',
  disposition: 'active' as const,
  authority: implemented,
  writeCapture: implemented,
  typedCuePredicate: implemented,
  presentationDrill: implemented,
  consumerAllowedUse: implemented,
  consumptionReceipt: implemented,
  outcome: implemented,
  invalidation: implemented,
  evidence: {
    level: 'UAT' as const,
    refs: ['https://github.com/zts212653/clowder-ai/pull/4019'],
    limitations: 'Alpha only; production remains dormant.',
  },
};

const recallFrame = {
  v: 0 as const,
  frameId: 'recall-frame-fixture-1',
  trigger: {
    kind: 'typed_event' as const,
    eventKind: 'approved_taste_invoked',
    eventRef: 'thread-message://thread-1/message-1',
    eventRevision: `sha256:${'a'.repeat(64)}`,
  },
  predicateRevision: 'ExplicitApprovedTasteTriggerCatalog.v2',
  constructorRef: 'F287.MemoryCueService',
  constructorRevision: 'main:de0567d46',
  sourceRefs: [
    {
      sourceRef: 'taste-vignette:docs/taste/vignettes/visual-quality-ELI5-pcpjsd.md',
      sourceRevision: `sha256:${'b'.repeat(64)}`,
      authorityRef: 'docs/features/F221-taste-lane.md',
      eligibilityRef: 'F287:owner_message/approved_taste_invoked',
    },
  ],
  asOf: 1_787_920_000_000,
  delivery: { state: 'drilled' as const, refs: ['cue-episode:presented', 'cue-episode:drilled'] },
  application: { state: 'applied' as const, refs: ['rich-block:html_widget'] },
  outcome: { state: 'not_observed' as const, refs: [] },
  invalidation: { state: 'none_observed' as const, refs: [] },
  materialization: { mode: 'ephemeral' as const },
};

describe('Memory Architecture Closure contracts', () => {
  it('accepts a fully answered active surface and rejects active declarations with a missing answer', () => {
    expect(memorySurfaceClosureV1Schema.safeParse(closure).success).toBe(true);
    expect(
      memorySurfaceClosureV1Schema.safeParse({
        ...closure,
        typedCuePredicate: {
          state: 'missing',
          summary: 'No typed predicate.',
          evidenceLevel: 'main',
          evidenceRefs: [],
          breakClass: 'B1',
          ownerRefs: ['docs/features/F221-taste-lane.md'],
          nextAction: 'Add a lane-owned predicate or change the disposition.',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown placeholders anywhere in a closure declaration', () => {
    expect(
      memorySurfaceClosureV1Schema.safeParse({
        ...closure,
        authority: { ...implemented, summary: 'owner is unknown' },
      }).success,
    ).toBe(false);
  });

  it('freezes an ephemeral RecallFrame v0 without raw query or source payload', () => {
    expect(memoryRecallFrameV0Schema.safeParse(recallFrame).success).toBe(true);
    expect(memoryRecallFrameV0Schema.safeParse({ ...recallFrame, rawQuery: 'private owner text' }).success).toBe(false);
    expect(
      memoryRecallFrameV0Schema.safeParse({
        ...recallFrame,
        sourceRefs: [{ ...recallFrame.sourceRefs[0], transcript: 'private source body' }],
      }).success,
    ).toBe(false);
  });

  it('accepts the query trigger variant only as a source reference plus revision', () => {
    expect(
      memoryRecallFrameV0Schema.safeParse({
        ...recallFrame,
        trigger: {
          kind: 'query',
          queryRef: 'thread-message://thread-1/message-2#query',
          queryRevision: `sha256:${'c'.repeat(64)}`,
        },
      }).success,
    ).toBe(true);
    expect(
      memoryRecallFrameV0Schema.safeParse({
        ...recallFrame,
        trigger: {
          kind: 'query',
          queryRef: 'thread-message://thread-1/message-2#query',
          queryRevision: `sha256:${'c'.repeat(64)}`,
          rawQuery: 'private query body',
        },
      }).success,
    ).toBe(false);
  });

  it('requires a persisted RecallFrame to name the frozen Derived View Contract', () => {
    expect(
      memoryRecallFrameV0Schema.safeParse({
        ...recallFrame,
        materialization: {
          mode: 'persisted',
          viewRef: 'memory-derived-view://fixture-1',
          derivedViewContractRef: 'some-other-contract',
        },
      }).success,
    ).toBe(false);
    expect(
      memoryRecallFrameV0Schema.safeParse({
        ...recallFrame,
        materialization: {
          mode: 'persisted',
          viewRef: 'memory-derived-view://fixture-1',
          derivedViewContractRef: 'MemoryDerivedViewContract.v1',
        },
      }).success,
    ).toBe(true);
  });
});
