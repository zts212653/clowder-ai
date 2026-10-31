import {
  type CandidateInteractionDraft,
  type PersonIdentityDraft,
  type PersonMemorySourceBundleInput,
  validatePersonMemoryAssertionMatrix,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import {
  type OwnerPrivateArtifactResolver,
  type PersonMemoryAssertionTargetResolution,
  PersonMemorySourceBundleResolver,
  type PersonMemorySourceResolution,
} from '../domains/memory/people/PersonMemorySourceBundleResolver.js';
import { proposalPersonMemoryDeltaCoordinates } from '../domains/memory/people/person-memory-delta-lineage.js';
import type { WorkspacePersonResolver } from '../domains/memory/people/WorkspacePersonResolver.js';
import { resolveWorkspacePersonAliasSet } from '../domains/memory/people/WorkspacePersonResolver.js';
import type { requireCallbackAuth } from './callback-auth-prehandler.js';
import { assertionTargets, candidateIdForProposal, derivePersonDraft } from './person-memory-proposal-candidate.js';
import { type PersonMemoryProposalFailure, proposalPreflightFailure } from './person-memory-proposal-preflight.js';
import {
  legacySourceBundle,
  type ProposePersonMemoryBody,
  requiredInteractionFields,
  resolvedBindingsAreMaterializable,
  resolveInteractionSourceEvidence,
  resolveProposalSourceMessageId,
} from './person-memory-proposal-source-contract.js';

export interface PreparedPersonMemoryProposal {
  auth: NonNullable<ReturnType<typeof requireCallbackAuth>>;
  body: ProposePersonMemoryBody;
  originMessageId: string;
}

export interface PersonMemoryProposalEvidenceDeps {
  messageStore: IMessageStore;
  workspacePersonResolver: WorkspacePersonResolver;
  ownerPrivateArtifactResolver?: OwnerPrivateArtifactResolver;
}

export type ProposalStep<T> = { status: 'ok'; value: T } | { status: 'error'; failure: PersonMemoryProposalFailure };

export interface ResolvedProposalEvidence {
  proposalSourceMessageId: string;
  publicSourceBundle: PersonMemorySourceBundleInput;
  sourceResolver: PersonMemorySourceBundleResolver;
  sourceResolution: Extract<PersonMemorySourceResolution, { status: 'resolved' }>;
  targets: PersonMemoryAssertionTargetResolution;
  interactionSourceEvidence: CandidateInteractionDraft['sourceEvidence'];
}

export async function resolveProposalEvidence(
  prepared: PreparedPersonMemoryProposal,
  deps: PersonMemoryProposalEvidenceDeps,
): Promise<ProposalStep<ResolvedProposalEvidence>> {
  const { auth, body, originMessageId } = prepared;
  const proposalSourceMessageId = await resolveProposalSourceMessageId(deps.messageStore, body, auth, originMessageId);
  if (proposalSourceMessageId === null) {
    return {
      status: 'error',
      failure: proposalPreflightFailure('invalid_proposal_source', 'source', {
        code: 'source_not_eligible',
        message: '提案来源不符合 owner/private-memory 证据要求。',
        action: '改用同一 owner 仍可见的精确原始消息后重新提交。',
        path: 'sourceMessageId',
      }),
    };
  }
  const publicSourceBundle = body.sourceBundle ?? legacySourceBundle(body, proposalSourceMessageId);
  const matrixErrors = validatePersonMemoryAssertionMatrix({
    claims: body.claims.map((claim) => claim.payload),
    hasRelationship: body.relationship !== undefined,
    hasInteraction: body.interaction !== undefined,
    requiredInteractionFields: requiredInteractionFields(body.interaction),
    bindings: publicSourceBundle.assertionBindings,
  });
  if (matrixErrors.some((error) => error.startsWith('agent_inference'))) {
    return {
      status: 'error',
      failure: proposalPreflightFailure(
        'owner_confirmation_required',
        'materializability',
        {
          code: 'owner_confirmation_required',
          message: '当前内容仍是 agent inference，不能写入 owner-private memory。',
          action: '请 owner 直接确认要记录的事实，再使用 owner-confirmed evidence 重提。',
        },
        { draft: '我目前只能推断……如果你确认，请直接陈述要记录的事实。' },
      ),
    };
  }
  if (matrixErrors.length > 0) {
    return {
      status: 'error',
      failure: proposalPreflightFailure(
        'invalid_assertion_binding',
        'materializability',
        {
          code: 'assertion_not_materializable',
          message: '至少一条 assertion role 不能支持所声明的目标字段。',
          action: '修正 source role 与 target field 的绑定后重新提交。',
          path: 'sourceBundle.assertionBindings',
        },
        { details: matrixErrors },
      ),
    };
  }
  const candidateId = candidateIdForProposal(body, auth);
  const targets = assertionTargets(candidateId, body);
  const sourceResolver = new PersonMemorySourceBundleResolver({
    messageStore: deps.messageStore,
    ...(deps.ownerPrivateArtifactResolver ? { ownerPrivateArtifactResolver: deps.ownerPrivateArtifactResolver } : {}),
  });
  const sourceResolution = await sourceResolver.resolve(publicSourceBundle, { ownerUserId: auth.userId }, targets);
  if (sourceResolution.status === 'invalid') {
    const error = !body.sourceBundle && body.interaction ? 'invalid_interaction_source' : sourceResolution.error;
    return {
      status: 'error',
      failure: proposalPreflightFailure(error, 'source', {
        code: 'source_not_eligible',
        message: '至少一个证据来源无法通过 owner、隐私、可见性或 digest 校验。',
        action: '改用仍可见且属于当前 owner 的精确来源后重新提交。',
        path: 'sourceBundle.sources',
      }),
    };
  }
  if (proposalPersonMemoryDeltaCoordinates(sourceResolution.bundle).status === 'duplicate') {
    return { status: 'error', failure: { statusCode: 422, payload: { error: 'duplicate_source_coordinate' } } };
  }
  if (!(await resolvedBindingsAreMaterializable(sourceResolution.bundle, deps.messageStore))) {
    return {
      status: 'error',
      failure: proposalPreflightFailure('invalid_assertion_binding', 'materializability', {
        code: 'assertion_not_materializable',
        message: '转述或 transcript-accuracy 证据不能证明 interaction fact。',
        action: '改绑为 owner direct observation，或只把转述保留为 quoted third-party evidence。',
        path: 'sourceBundle.assertionBindings',
      }),
    };
  }
  const interactionSourceEvidence = body.sourceBundle
    ? []
    : await resolveInteractionSourceEvidence(deps.messageStore, body.interaction, auth);
  if (interactionSourceEvidence === null) {
    return {
      status: 'error',
      failure: proposalPreflightFailure('invalid_interaction_source', 'source', {
        code: 'source_not_eligible',
        message: '互动证据来源不再符合 owner/visibility 要求。',
        action: '重新选择仍可见的 owner 原始消息，并逐字段绑定后提交。',
        path: 'interaction.sources',
      }),
    };
  }
  return {
    status: 'ok',
    value: {
      proposalSourceMessageId,
      publicSourceBundle,
      sourceResolver,
      sourceResolution,
      targets,
      interactionSourceEvidence,
    },
  };
}

export async function resolveProposalPerson(
  prepared: PreparedPersonMemoryProposal,
  deps: Pick<PersonMemoryProposalEvidenceDeps, 'workspacePersonResolver'>,
): Promise<ProposalStep<PersonIdentityDraft>> {
  const resolution = await resolveWorkspacePersonAliasSet(deps.workspacePersonResolver, [
    prepared.body.person.displayName,
    ...prepared.body.person.privateAliases,
  ]);
  const derived = derivePersonDraft(prepared.body.person, resolution);
  return derived.status === 'error'
    ? { status: 'error', failure: { statusCode: derived.statusCode, payload: { error: derived.error } } }
    : { status: 'ok', value: derived.person };
}
