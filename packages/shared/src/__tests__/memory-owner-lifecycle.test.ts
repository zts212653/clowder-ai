import { describe, expect, it } from 'vitest';
import {
  entityMemoryOwnerActionSchema,
  eventMemoryCorrectionProposalInputSchema,
  eventMemoryOwnerActionSchema,
  profileMemoryOwnerActionSchema,
  tasteMemoryCorrectionProposalInputSchema,
  tasteMemoryOwnerActionSchema,
} from '../types/memory-owner-lifecycle.js';

const requestId = 'owner-action:018f2d5e-9f45-7d8c-a829-88f6440a4f15';
const revision = `sha256:${'a'.repeat(64)}`;
const nextRevision = `sha256:${'b'.repeat(64)}`;

describe('F321 owner memory lifecycle contract', () => {
  it('binds every mutation to one high-entropy request and exact current revision', () => {
    for (const schema of [
      profileMemoryOwnerActionSchema,
      tasteMemoryOwnerActionSchema,
      entityMemoryOwnerActionSchema,
      eventMemoryOwnerActionSchema,
    ]) {
      expect(
        schema.safeParse({ action: 'hard_forget', requestId: 'short', expectedRevision: revision, confirmed: true })
          .success,
      ).toBe(false);
      expect(
        schema.safeParse({ action: 'hard_forget', requestId, expectedRevision: 'r1', confirmed: true }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ action: 'hard_forget', requestId, expectedRevision: revision, confirmed: false }).success,
      ).toBe(false);
    }
  });

  it('keeps Profile owner edits whole-document and does not invent a retire state', () => {
    expect(
      profileMemoryOwnerActionSchema.parse({
        action: 'replace_content',
        requestId,
        expectedRevision: revision,
        content: '# Current profile\n\nOne bounded owner edit.\n',
      }),
    ).toMatchObject({ action: 'replace_content', expectedRevision: revision });
    expect(
      profileMemoryOwnerActionSchema.safeParse({ action: 'retire', requestId, expectedRevision: revision }).success,
    ).toBe(false);
  });

  it('requires Taste candidate confirmation to bind both candidate and vignette revisions', () => {
    expect(
      tasteMemoryOwnerActionSchema.parse({
        action: 'confirm_takeaway',
        requestId,
        expectedRevision: revision,
        candidateRevision: nextRevision,
        takeaway: 'A concrete reusable preference hypothesis.',
      }),
    ).toMatchObject({ action: 'confirm_takeaway', candidateRevision: nextRevision });
    expect(
      tasteMemoryOwnerActionSchema.safeParse({
        action: 'confirm_takeaway',
        requestId,
        expectedRevision: revision,
        takeaway: 'Unbound draft',
      }).success,
    ).toBe(false);
  });

  it('requires non-empty bounded correction patches for Taste, Entity, and Event', () => {
    expect(
      tasteMemoryOwnerActionSchema.safeParse({ action: 'correct', requestId, expectedRevision: revision, patch: {} })
        .success,
    ).toBe(false);
    expect(
      entityMemoryOwnerActionSchema.safeParse({ action: 'correct', requestId, expectedRevision: revision, patch: {} })
        .success,
    ).toBe(false);
    expect(
      eventMemoryOwnerActionSchema.safeParse({ action: 'correct', requestId, expectedRevision: revision, patch: {} })
        .success,
    ).toBe(false);

    expect(
      tasteMemoryOwnerActionSchema.safeParse({
        action: 'correct',
        requestId,
        expectedRevision: revision,
        patch: { takeaway: 'A revised hypothesis.' },
      }).success,
    ).toBe(true);
    expect(
      entityMemoryOwnerActionSchema.safeParse({
        action: 'correct',
        requestId,
        expectedRevision: revision,
        patch: { canonicalName: 'Canonical identity' },
      }).success,
    ).toBe(true);
    expect(
      eventMemoryOwnerActionSchema.safeParse({
        action: 'correct',
        requestId,
        expectedRevision: revision,
        patch: { summary: 'Corrected bounded event summary.' },
      }).success,
    ).toBe(true);
  });

  it('rejects identity/source rewrites from browser correction payloads', () => {
    expect(
      eventMemoryOwnerActionSchema.safeParse({
        action: 'correct',
        requestId,
        expectedRevision: revision,
        patch: { threadId: 'other-thread' },
      }).success,
    ).toBe(false);
    expect(
      entityMemoryOwnerActionSchema.safeParse({
        action: 'correct',
        requestId,
        expectedRevision: revision,
        patch: { provenance: [{ source: 'spoofed' }] },
      }).success,
    ).toBe(false);
    expect(
      tasteMemoryOwnerActionSchema.safeParse({
        action: 'correct',
        requestId,
        expectedRevision: revision,
        patch: { privacy: 'public' },
      }).success,
    ).toBe(false);
  });

  it('binds Taste correction proposals to one existing vignette revision', () => {
    const valid = {
      target: {
        sourceAnchor: 'taste-vignette:docs/taste/vignettes/visual-quality-example.md',
        expectedRevision: revision,
        reason: 'unsupported_by_source',
        suggestedPatch: { takeaway: 'The quote supports a narrower hypothesis.' },
      },
      clientRequestId: requestId,
    };
    expect(tasteMemoryCorrectionProposalInputSchema.safeParse(valid).success).toBe(true);
    expect(
      tasteMemoryCorrectionProposalInputSchema.safeParse({
        ...valid,
        target: { ...valid.target, expectedRevision: undefined },
      }).success,
    ).toBe(false);
    expect(
      tasteMemoryCorrectionProposalInputSchema.safeParse({
        ...valid,
        target: { ...valid.target, sourceAnchor: 'project-document:docs/anything.md' },
      }).success,
    ).toBe(false);
  });

  it('keeps Event correction proposals in the Event lane and server-binds source coordinates', () => {
    const valid = {
      eventId: 'evt_existing',
      expectedRevision: revision,
      reason: 'outdated',
      suggestedPatch: { summary: 'This event should be described in its later context.' },
      clientRequestId: requestId,
    };
    expect(eventMemoryCorrectionProposalInputSchema.safeParse(valid).success).toBe(true);
    expect(
      eventMemoryCorrectionProposalInputSchema.safeParse({
        ...valid,
        threadId: 'spoofed-thread',
        messageId: 'spoofed-message',
        ownerUserId: 'spoofed-owner',
      }).success,
    ).toBe(false);
  });
});
