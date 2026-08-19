/**
 * F276 Task 1: owner-private people and relationship memory contracts.
 *
 * These tests intentionally exercise runtime schemas, not just TypeScript
 * assignability: untrusted callback/API payloads must fail closed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  candidateClaimDraftSchema,
  candidateInteractionProposalSchema,
  captureCandidateSchema,
  interactionEventSchema,
  materializationAuthoritySchema,
  PERSON_MEMORY_LIMITS,
  personClaimVersionSchema,
  personIdentitySchema,
  personMemoryAssertionBindingSchema,
  personMemoryResolvedSourceBundleSchema,
  personMemorySourceBundleInputSchema,
  personMemorySuppressionTokenSchema,
  personRelationshipSchema,
  relationshipCardSchema,
  temporalValueSchema,
  validatePersonMemoryAssertionMatrix,
} from '../types/person-memory.js';
import {
  personMemoryInformedEvidenceSchema,
  personMemoryProposalPreflightBlockSchema,
} from '../types/person-memory-preflight.js';

const sourceMessageRef = {
  kind: 'message' as const,
  threadId: 'thread_owner_private',
  messageId: '0001785058845897-000213-8cb7a3dd',
};
const secondSourceMessageRef = {
  kind: 'message' as const,
  threadId: 'thread_owner_private',
  messageId: '0001785059633834-000252-42d139ea',
};

const cardApproval = {
  kind: 'card_approval' as const,
  candidateId: 'person_candidate_1',
  draftId: 'person_draft_1',
  authorizedAt: 10,
};

const reportedFact = {
  kind: 'reported_fact' as const,
  predicate: 'organization_unit',
  value: '终端用户计算开发部',
  assertedBy: 'owner' as const,
};

describe('F276 shared person-memory contract', () => {
  it('keeps Phase C preflight actionable and informed evidence content-bounded', () => {
    assert.equal(
      personMemoryProposalPreflightBlockSchema.safeParse({
        status: 'blocked',
        phase: 'card_budget',
        issues: [
          {
            code: 'card_token_budget_exceeded',
            message: '审批卡超出 240 token 上限。',
            action: '拆成更少的 exact-bind items 后重新提交。',
          },
        ],
        budget: { kind: 'candidate_card', estimatedTokens: 241, maxTokens: 240 },
      }).success,
      true,
    );
    const evidence = {
      sourceId: 'meeting-source',
      sourceKind: 'owner_private_artifact',
      assertionRoles: ['reported_fact'],
      targetFields: ['eventKind', 'headline'],
      boundedExcerpt: '与 Alden 讨论主动记忆',
      drillSourceRef: sourceMessageRef,
    };
    assert.equal(personMemoryInformedEvidenceSchema.safeParse(evidence).success, true);
    assert.equal(
      personMemoryInformedEvidenceSchema.safeParse({
        ...evidence,
        artifactLocator: 'workspace:people/alden.md',
      }).success,
      false,
      'informed projection must never expose private artifact locators',
    );
    assert.equal(
      personMemoryInformedEvidenceSchema.safeParse({
        ...evidence,
        resolvedDigest: 'a'.repeat(64),
      }).success,
      false,
      'informed projection must never expose source digests',
    );
  });

  it('keeps dormant suppression owner-scoped and content-bounded', () => {
    const token = {
      tokenId: 'person_suppression_alden',
      ownerUserId: 'owner-1',
      candidateId: 'person_candidate_alden',
      subjectRefs: ['alden', 'alden k.'],
      createdAt: 10,
    };
    assert.equal(personMemorySuppressionTokenSchema.safeParse(token).success, true);
    assert.equal(
      personMemorySuppressionTokenSchema.safeParse({
        ...token,
        subjectRefs: ['alden', 'alden'],
      }).success,
      false,
    );
    assert.equal(
      personMemorySuppressionTokenSchema.safeParse({
        ...token,
        subjectRefs: [],
      }).success,
      false,
    );
  });

  it('accepts only materializable owner claims and rejects inference laundering', () => {
    assert.equal(
      candidateClaimDraftSchema.safeParse({
        draftId: 'person_draft_1',
        payload: reportedFact,
        normalizedDraft: '黄挺属于终端用户计算开发部',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: '黄挺是终端用户计算开发部 21 级',
        decision: 'pending',
      }).success,
      true,
    );

    const inference = candidateClaimDraftSchema.safeParse({
      draftId: 'person_draft_2',
      payload: {
        kind: 'agent_inference',
        statement: '可能和 You 同部门',
        authorCatId: 'codex-sol',
        modelId: 'gpt-5.6-sol',
        confidence: 'low',
      },
      normalizedDraft: '可能和 You 同部门',
      sourceRole: 'owner_explicit',
      evidenceExcerpt: '可能和 You 同部门',
      decision: 'pending',
    });
    assert.equal(inference.success, false);

    const unknownSourceRole = candidateClaimDraftSchema.safeParse({
      draftId: 'person_draft_3',
      payload: reportedFact,
      normalizedDraft: '黄挺属于终端用户计算开发部',
      sourceRole: 'agent_inference',
      evidenceExcerpt: '黄挺属于终端用户计算开发部',
      decision: 'pending',
    });
    assert.equal(unknownSourceRole.success, false);
  });

  it('separates strict public source locators from server-resolved owner evidence', () => {
    const publicBundle = {
      sources: [
        {
          sourceId: 'source-message',
          kind: 'message_text',
          messageId: sourceMessageRef.messageId,
          expectedDigest: 'a'.repeat(64),
          excerpt: '黄挺是终端用户计算开发部 21 级',
        },
        {
          sourceId: 'source-attachment',
          kind: 'message_attachment',
          messageId: sourceMessageRef.messageId,
          attachmentLocator: { surface: 'content_block', index: 0 },
          expectedDigest: 'b'.repeat(64),
          boundedTranscript: '截图显示黄挺属于终端用户计算开发部',
        },
        {
          sourceId: 'source-transcript',
          kind: 'owner_confirmed_transcript',
          transcript: '周玉晶负责这项工作',
          transcriptDigest: 'c'.repeat(64),
          confirmationMessageId: secondSourceMessageRef.messageId,
          confirmationScope: 'transcript_accuracy',
        },
        {
          sourceId: 'source-artifact',
          kind: 'owner_private_artifact',
          artifactLocator: 'workspace:people/zhou-yujing.md#role',
          expectedDigest: 'd'.repeat(64),
          boundedExcerpt: '周玉晶负责这项工作',
          confirmationMessageId: secondSourceMessageRef.messageId,
        },
      ],
      assertionBindings: [
        {
          sourceId: 'source-message',
          target: { kind: 'claim', index: 0 },
          role: 'reported_fact',
        },
      ],
    };
    assert.equal(personMemorySourceBundleInputSchema.safeParse(publicBundle).success, true);
    assert.equal(
      personMemorySourceBundleInputSchema.safeParse({
        ...publicBundle,
        sources: [
          {
            ...publicBundle.sources[0],
            ownerUserId: 'forged-owner',
            resolvedDigest: 'f'.repeat(64),
          },
        ],
      }).success,
      false,
    );
    assert.equal(
      personMemorySourceBundleInputSchema.safeParse({
        ...publicBundle,
        sources: [
          {
            ...publicBundle.sources[1],
            attachmentLocator: { surface: 'content_block', index: -1 },
          },
        ],
      }).success,
      false,
    );
    assert.equal(
      personMemorySourceBundleInputSchema.safeParse({
        ...publicBundle,
        sources: [
          {
            ...publicBundle.sources[3],
            artifactLocator: '../../private.txt',
          },
        ],
      }).success,
      false,
    );
  });

  it('keeps assertion roles and resolved provenance targets typed and bounded', () => {
    const resolvedBundle = {
      sources: [
        {
          sourceId: 'source-message',
          kind: 'message_text',
          sourceRef: sourceMessageRef,
          ownerUserId: 'owner-1',
          resolvedDigest: 'a'.repeat(64),
          excerpt: '黄挺是终端用户计算开发部 21 级',
        },
      ],
      assertionBindings: [
        {
          sourceId: 'source-message',
          target: { kind: 'claim', draftId: 'person_draft_1' },
          role: 'reported_fact',
        },
      ],
    };
    assert.equal(personMemoryResolvedSourceBundleSchema.safeParse(resolvedBundle).success, true);
    assert.equal(
      personMemoryResolvedSourceBundleSchema.safeParse({
        ...resolvedBundle,
        assertionBindings: [
          {
            sourceId: 'missing-source',
            target: { kind: 'claim', draftId: 'person_draft_1' },
            role: 'reported_fact',
          },
        ],
      }).success,
      false,
    );
    assert.equal(
      personMemoryAssertionBindingSchema.safeParse({
        sourceId: 'source-message',
        target: { kind: 'interaction', field: 'headline' },
        role: 'agent_inference',
      }).success,
      true,
      'public ingress must parse inference so the API can return the typed confirmation response before writes',
    );
  });

  it('enforces role-target ceilings before any candidate can be staged', () => {
    const base = {
      claims: [],
      hasRelationship: false,
      hasInteraction: true,
    };
    assert.deepEqual(
      validatePersonMemoryAssertionMatrix({
        ...base,
        bindings: [
          {
            sourceId: 'source-message',
            target: { kind: 'interaction', field: 'occurredAt' },
            role: 'quoted_third_party',
          },
        ],
      }),
      ['quoted_third_party cannot support interaction occurredAt'],
    );
    assert.deepEqual(
      validatePersonMemoryAssertionMatrix({
        ...base,
        bindings: [
          {
            sourceId: 'source-message',
            target: { kind: 'interaction', field: 'headline' },
            role: 'agent_inference',
          },
        ],
      }),
      ['agent_inference requires owner confirmation before proposal staging'],
    );
    assert.deepEqual(
      validatePersonMemoryAssertionMatrix({
        ...base,
        bindings: [
          {
            sourceId: 'source-message',
            target: { kind: 'interaction', field: 'importanceOrTopic' },
            role: 'user_assessment',
          },
        ],
      }),
      [],
    );
  });

  it('preserves approximate time and date/weekday conflicts as typed values', () => {
    const approximateDuration = temporalValueSchema.parse({
      kind: 'approximate',
      raw: '大约两个小时',
      qualifier: 'about',
    });
    assert.equal(approximateDuration.kind, 'approximate');

    const conflict = temporalValueSchema.parse({
      kind: 'conflict',
      raw: '7 月 23 日（周三）',
      alternatives: [
        { label: 'explicit_date', value: '2026-07-23' },
        { label: 'weekday_resolution', value: '2026-07-22' },
      ],
    });
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.alternatives.length, 2);

    assert.equal(
      temporalValueSchema.safeParse({
        kind: 'conflict',
        raw: '7 月 23 日（周三）',
        alternatives: [{ label: 'silently_chosen', value: '2026-07-23' }],
      }).success,
      false,
    );
  });

  it('bounds a visible candidate to one person and at most three exact-bind drafts', () => {
    const base = {
      candidateId: 'person_candidate_1',
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      sourceMessageRef,
      personDraft: {
        displayName: '黄挺',
        privateAliases: ['黄挺'],
      },
      claimDrafts: [
        {
          draftId: 'person_draft_1',
          payload: reportedFact,
          normalizedDraft: '黄挺属于终端用户计算开发部',
          sourceRole: 'owner_explicit',
          evidenceExcerpt: '黄挺是终端用户计算开发部 21 级',
          decision: 'pending',
        },
      ],
      state: 'pending_approval',
      presentedAt: 10,
      remainingDraftIds: ['person_draft_1'],
      retention: 'owner_controlled_no_ttl',
      createdAt: 10,
    };

    assert.equal(captureCandidateSchema.safeParse(base).success, true);
    assert.equal(
      captureCandidateSchema.safeParse({
        ...base,
        claimDrafts: Array.from({ length: PERSON_MEMORY_LIMITS.maxClaimsPerCandidate + 1 }, (_, index) => ({
          ...base.claimDrafts[0],
          draftId: `person_draft_${index + 1}`,
        })),
      }).success,
      false,
    );
    assert.equal(
      captureCandidateSchema.safeParse({
        ...base,
        remainingDraftIds: ['person_draft_unknown'],
      }).success,
      false,
    );
    assert.equal(
      captureCandidateSchema.safeParse({
        ...base,
        replacesProposalId: 'person_candidate_previous',
      }).success,
      true,
    );
    assert.equal(
      captureCandidateSchema.safeParse({
        ...base,
        replacesProposalId: base.candidateId,
      }).success,
      false,
    );
    assert.equal(
      captureCandidateSchema.safeParse({
        ...base,
        replacedByProposalId: 'person_candidate_corrected',
      }).success,
      false,
    );
    assert.equal(
      captureCandidateSchema.safeParse({
        ...base,
        personDraft: undefined,
        claimDrafts: [],
        remainingDraftIds: [],
        state: 'withdrawn',
        replacedByProposalId: 'person_candidate_corrected',
      }).success,
      true,
    );
  });

  it('exact-binds relationship and interaction drafts instead of approving them implicitly', () => {
    const eventOnlyCandidate = {
      candidateId: 'person_candidate_event_1',
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      sourceMessageRef,
      personDraft: {
        displayName: '黄挺',
        privateAliases: ['黄挺'],
      },
      claimDrafts: [],
      interactionDraft: {
        draftId: 'person_draft_event_1',
        payload: {
          occurredAt: {
            kind: 'conflict',
            raw: '7 月 23 日（周三）',
            alternatives: [
              { label: 'explicit_date', value: '2026-07-23' },
              { label: 'weekday_resolution', value: '2026-07-22' },
            ],
          },
          duration: {
            kind: 'approximate',
            raw: '大约两个小时',
            qualifier: 'about',
          },
          eventKind: 'meeting',
          headline: '与黄挺线下见面并讨论终端用户计算',
          importanceOrTopic: '交流终端用户计算方向，也让双方关系更具体',
          uncertaintyNotes: ['日期与星期存在冲突'],
        },
        normalizedDraft: '与黄挺线下见面，日期存在周三/7 月 23 日冲突，时长约两小时',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: '7 月 23 日周三，见了大约两个小时',
        sourceEvidence: [
          {
            sourceRef: sourceMessageRef,
            evidenceExcerpt: '7 月 23 日周三，见了大约两个小时',
            supports: ['eventKind', 'headline', 'occurredAt', 'duration'],
          },
          {
            sourceRef: secondSourceMessageRef,
            evidenceExcerpt: '聊了终端用户计算，这次见面对我挺重要',
            supports: ['importanceOrTopic', 'uncertaintyNotes'],
          },
        ],
        decision: 'pending',
      },
      state: 'pending_approval',
      presentedAt: 10,
      remainingDraftIds: ['person_draft_event_1'],
      retention: 'owner_controlled_no_ttl',
      createdAt: 10,
    };

    assert.equal(captureCandidateSchema.safeParse(eventOnlyCandidate).success, true);
    assert.deepEqual(
      captureCandidateSchema
        .parse(eventOnlyCandidate)
        .interactionDraft?.sourceEvidence.map((source) => source.sourceRef.messageId),
      [sourceMessageRef.messageId, secondSourceMessageRef.messageId],
    );
    assert.equal(
      captureCandidateSchema.safeParse({
        ...eventOnlyCandidate,
        remainingDraftIds: ['person_draft_unrelated'],
      }).success,
      false,
    );
    assert.equal(
      captureCandidateSchema.safeParse({
        ...eventOnlyCandidate,
        interactionDraft: {
          ...eventOnlyCandidate.interactionDraft,
          sourceEvidence: eventOnlyCandidate.interactionDraft.sourceEvidence.map((source) => ({
            ...source,
            supports: source.supports.filter((field) => field !== 'importanceOrTopic'),
          })),
        },
      }).success,
      false,
    );
    assert.equal(
      captureCandidateSchema.safeParse({
        ...eventOnlyCandidate,
        interactionDraft: {
          ...eventOnlyCandidate.interactionDraft,
          sourceEvidence: Array.from({ length: 9 }, (_, index) => ({
            ...eventOnlyCandidate.interactionDraft.sourceEvidence[0],
            sourceRef: {
              ...sourceMessageRef,
              messageId: `message_event_source_${index}`,
            },
          })),
        },
      }).success,
      false,
    );
  });

  it('requires proposal evidence coverage before server-derived source refs exist', () => {
    const proposal = {
      payload: {
        occurredAt: { kind: 'exact', value: '2026-07-23' },
        duration: { kind: 'approximate', raw: '大约两个小时', qualifier: 'about' },
        eventKind: 'meeting',
        headline: '与黄挺线下见面',
        importanceOrTopic: '讨论终端用户计算方向',
        uncertaintyNotes: [],
      },
      normalizedDraft: '与黄挺线下见面约两小时，讨论终端用户计算',
      sourceRole: 'owner_explicit',
      evidenceExcerpt: '见了大约两个小时',
      sources: [
        {
          messageId: sourceMessageRef.messageId,
          evidenceExcerpt: '见了大约两个小时',
          supports: ['eventKind', 'headline', 'occurredAt', 'duration'],
        },
        {
          messageId: secondSourceMessageRef.messageId,
          evidenceExcerpt: '聊了终端用户计算',
          supports: ['importanceOrTopic'],
        },
      ],
    };
    assert.equal(candidateInteractionProposalSchema.safeParse(proposal).success, true);
    assert.equal(
      candidateInteractionProposalSchema.safeParse({
        ...proposal,
        sources: proposal.sources.map((source) => ({
          ...source,
          supports: source.supports.filter((field) => field !== 'headline'),
        })),
      }).success,
      false,
    );
  });

  it('models all three materialization authorities without accepting an unanchored write', () => {
    assert.equal(materializationAuthoritySchema.safeParse(cardApproval).success, true);
    assert.equal(
      materializationAuthoritySchema.safeParse({
        kind: 'explicit_memory_command',
        sourceMessageRef,
        boundedTarget: 'person_draft_1',
        authorizedAt: 11,
      }).success,
      true,
    );
    assert.equal(
      materializationAuthoritySchema.safeParse({
        kind: 'anchored_correction',
        sourceMessageRef,
        existingTruthRef: 'person_claim_1',
        authorizedAt: 12,
      }).success,
      true,
    );
    assert.equal(
      materializationAuthoritySchema.safeParse({
        kind: 'ordinary_assertion',
        sourceMessageRef,
        authorizedAt: 13,
      }).success,
      false,
    );
  });

  it('separates identity, versioned claims, relationship, and append-only events', () => {
    assert.equal(
      personIdentitySchema.safeParse({
        personId: 'person_1',
        ownerUserId: 'owner-1',
        displayName: '黄挺',
        privateAliases: ['黄挺'],
        workspaceEntityLink: {
          entityRef: 'person:huang-ting-huawei',
          state: 'linked',
          checkedAt: 10,
        },
        status: 'active',
        materializedBy: cardApproval,
        createdAt: 10,
        sourceRefs: [sourceMessageRef],
      }).success,
      true,
    );
    assert.equal(
      personClaimVersionSchema.safeParse({
        claimId: 'person_claim_1',
        personId: 'person_1',
        ownerUserId: 'owner-1',
        payload: reportedFact,
        status: 'current',
        recordedAt: 10,
        sourceRefs: [sourceMessageRef],
        materializedBy: cardApproval,
      }).success,
      true,
    );
    assert.equal(
      personRelationshipSchema.safeParse({
        relationshipId: 'relationship_1',
        ownerUserId: 'owner-1',
        personId: 'person_1',
        status: 'current',
        materializedBy: cardApproval,
        createdAt: 10,
        sourceRefs: [sourceMessageRef],
        transitions: [
          {
            status: 'current',
            recordedAt: 10,
            materializedBy: cardApproval,
            sourceRefs: [sourceMessageRef],
          },
        ],
      }).success,
      true,
    );
    assert.equal(
      interactionEventSchema.safeParse({
        eventId: 'person_event_1',
        relationshipId: 'relationship_1',
        ownerUserId: 'owner-1',
        occurredAt: {
          kind: 'conflict',
          raw: '7 月 23 日（周三）',
          alternatives: [
            { label: 'explicit_date', value: '2026-07-23' },
            { label: 'weekday_resolution', value: '2026-07-22' },
          ],
        },
        duration: {
          kind: 'approximate',
          raw: '大约两个小时',
          qualifier: 'about',
        },
        recordedAt: 10,
        eventKind: 'meeting',
        headline: '线下见面',
        sourceRefs: [sourceMessageRef],
        materializedBy: cardApproval,
        status: 'active',
      }).success,
      true,
    );
    assert.equal(
      personClaimVersionSchema.safeParse({
        claimId: 'person_claim_redacted',
        personId: 'person_1',
        ownerUserId: 'owner-1',
        payload: { kind: 'redacted' },
        status: 'redacted',
        recordedAt: 11,
        sourceRefs: [],
        typedProvenance: {
          sources: [
            {
              sourceId: 'source-message',
              kind: 'message_text',
              sourceRef: sourceMessageRef,
              ownerUserId: 'owner-1',
              resolvedDigest: 'a'.repeat(64),
              excerpt: '不应残留',
            },
          ],
          assertionBindings: [
            {
              sourceId: 'source-message',
              target: { kind: 'claim', draftId: 'person_draft_1' },
              role: 'reported_fact',
            },
          ],
        },
        materializedBy: cardApproval,
      }).success,
      false,
      'redaction must purge typed provenance together with payload and source refs',
    );
  });

  it('makes relationship cards derived, non-storable, non-indexable, and bounded', () => {
    const base = {
      personId: 'person_1',
      relationshipId: 'relationship_1',
      displayName: '黄挺',
      facts: [
        {
          claimId: 'person_claim_1',
          text: '终端用户计算开发部 21 级',
          kind: 'reported_fact',
          provenanceRefs: [sourceMessageRef],
        },
      ],
      relationshipLine: 'You 的同事',
      latestInteraction: {
        eventId: 'person_event_1',
        headline: '最近线下见面',
      },
      uncertainty: [],
      provenanceRefs: [sourceMessageRef],
      dossierRef: 'person_1',
      estimatedTokens: 72,
      storable: false,
      indexable: false,
    };
    assert.equal(relationshipCardSchema.safeParse(base).success, true);
    assert.equal(
      relationshipCardSchema.safeParse({
        ...base,
        facts: Array.from({ length: PERSON_MEMORY_LIMITS.maxFactsPerRelationshipCard + 1 }, (_, index) => ({
          ...base.facts[0],
          claimId: `person_claim_${index + 1}`,
        })),
      }).success,
      false,
    );
    assert.equal(
      relationshipCardSchema.safeParse({
        ...base,
        estimatedTokens: PERSON_MEMORY_LIMITS.maxRelationshipCardTokens + 1,
      }).success,
      false,
    );
    assert.equal(relationshipCardSchema.safeParse({ ...base, storable: true }).success, false);
  });
});
