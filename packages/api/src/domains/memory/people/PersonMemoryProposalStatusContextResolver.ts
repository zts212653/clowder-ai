import { captureCandidateIdSchema, isPersonMemoryProposalCardBlock } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { PersonMemoryStore } from './PersonMemoryStore.js';
import { normalizePrivateAlias } from './person-memory-keys.js';
import { projectPersonMemoryProposalStatus } from './person-memory-proposal-status.js';

const PROPOSAL_CONTEXT_LIMIT = 8;
const MESSAGE_DISCOVERY_LIMIT = 200;
const LEGACY_TITLE_PREFIX = '要把 ';
const LEGACY_TITLE_SUFFIX = ' 记下来吗？';

interface ProposalReference {
  candidateId: string;
  subjectDisplayName?: string;
}

function isCandidateIdCharacter(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9._:-]$/.test(value);
}

function candidateIdReferenceIndex(prompt: string, candidateId: string): number {
  let searchFrom = 0;
  while (searchFrom < prompt.length) {
    const matchIndex = prompt.indexOf(candidateId, searchFrom);
    if (matchIndex < 0) return -1;
    const before = prompt[matchIndex - 1];
    const after = prompt[matchIndex + candidateId.length];
    if (!isCandidateIdCharacter(before) && !isCandidateIdCharacter(after)) return matchIndex;
    searchFrom = matchIndex + candidateId.length;
  }
  return -1;
}

function legacySubjectDisplayName(title: string): string | undefined {
  if (!title.startsWith(LEGACY_TITLE_PREFIX) || !title.endsWith(LEGACY_TITLE_SUFFIX)) return undefined;
  const displayName = title.slice(LEGACY_TITLE_PREFIX.length, -LEGACY_TITLE_SUFFIX.length).trim();
  return displayName || undefined;
}

function subjectReferenceIndex(normalizedPrompt: string, displayName: string | undefined): number {
  if (!displayName) return -1;
  const normalizedDisplayName = normalizePrivateAlias(displayName);
  return normalizedDisplayName ? normalizedPrompt.indexOf(normalizedDisplayName) : -1;
}

function proposalReferencesFromMessages(messages: readonly StoredMessage[]): ProposalReference[] {
  const proposals: ProposalReference[] = [];
  const seen = new Set<string>();
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const blocks = messages[messageIndex]?.extra?.rich?.blocks ?? [];
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = blocks[blockIndex];
      if (!isPersonMemoryProposalCardBlock(block)) continue;
      const parsedCandidateId = captureCandidateIdSchema.safeParse(block.meta.candidateId);
      if (!parsedCandidateId.success) continue;
      const candidateId = parsedCandidateId.data;
      if (seen.has(candidateId)) continue;
      seen.add(candidateId);
      proposals.push({
        candidateId,
        subjectDisplayName: block.meta.subjectDisplayName ?? legacySubjectDisplayName(block.title),
      });
    }
  }
  return proposals;
}

function rankProposalReferences(
  proposals: readonly ProposalReference[],
  currentPrompt: string,
): { selected: ProposalReference[]; matchedPrompt: boolean } {
  const normalizedPrompt = normalizePrivateAlias(currentPrompt);
  const requested = proposals
    .map((proposal) => {
      const { candidateId, subjectDisplayName } = proposal;
      const candidateIndex = candidateIdReferenceIndex(currentPrompt, candidateId);
      const subjectIndex = subjectReferenceIndex(normalizedPrompt, subjectDisplayName);
      const references = [candidateIndex, subjectIndex].filter((index) => index >= 0);
      return {
        proposal,
        referenceIndex: references.length > 0 ? Math.min(...references) : -1,
      };
    })
    .filter((entry) => entry.referenceIndex >= 0)
    .sort((left, right) => left.referenceIndex - right.referenceIndex)
    .map((entry) => entry.proposal);
  const requestedIds = new Set(requested.map((proposal) => proposal.candidateId));
  return {
    selected: [...requested, ...proposals.filter((proposal) => !requestedIds.has(proposal.candidateId))].slice(
      0,
      PROPOSAL_CONTEXT_LIMIT,
    ),
    matchedPrompt: requested.length > 0,
  };
}

function looksLikeProposalStatusQuestion(prompt: string): boolean {
  return /(?:状态|审批|待审批|撤回|拒绝|合入|通过|status|pending|approved|withdrawn|rejected|materialized)/iu.test(
    prompt,
  );
}

function subjectField(subjectDisplayName: string | undefined): string {
  return subjectDisplayName ? ` subject=${JSON.stringify(subjectDisplayName)}` : '';
}

function unavailableContext(
  reason: 'message_history_unavailable' | 'candidate_unavailable',
  candidateId?: string,
): string {
  const target = candidateId
    ? `proposalId=${candidateId} liveStatus=not_available`
    : 'proposal discovery=not_available';
  return [
    '## F276 权威提案状态（服务端实时投影）',
    `- ${target}`,
    `- reason=${reason}`,
    '- 当前状态无法从权威 store 验证；不得从聊天记录、旧卡片或先前回复推断状态。',
    '- 如用户询问状态，只能回答“当前无法验证”，或用精确 proposalId 调用实时只读状态工具。',
  ].join('\n');
}

/**
 * F276 status-answer guard.
 *
 * The resolver detects typed F276 cards from persisted message metadata and
 * reads their current owner-scoped candidates before every model invocation.
 * Historical card metadata is deliberately ignored after candidate discovery.
 */
export class PersonMemoryProposalStatusContextResolver {
  constructor(
    private readonly candidateStore: Pick<PersonMemoryStore, 'getCandidateForOwner'> | null,
    private readonly messageStore: Pick<IMessageStore, 'getByThread'>,
  ) {}

  async resolve(ownerUserId: string, threadId: string, currentPrompt = ''): Promise<string> {
    let messages: readonly StoredMessage[];
    try {
      // RedisMessageStore implements this as a bounded reverse read. Never hydrate
      // the lifetime of a persistent thread on every serial/parallel invocation.
      messages = await this.messageStore.getByThread(threadId, MESSAGE_DISCOVERY_LIMIT, ownerUserId);
    } catch {
      return unavailableContext('message_history_unavailable');
    }

    const proposals = proposalReferencesFromMessages(messages);
    if (proposals.length === 0) {
      return looksLikeProposalStatusQuestion(currentPrompt) ? unavailableContext('candidate_unavailable') : '';
    }
    const { selected, matchedPrompt } = rankProposalReferences(proposals, currentPrompt);

    const lines = await Promise.all(
      selected.map(async ({ candidateId, subjectDisplayName }) => {
        const subject = subjectField(subjectDisplayName);
        if (!this.candidateStore) {
          return `- proposalId=${candidateId}${subject} liveStatus=not_available reason=candidate_store_unavailable`;
        }
        try {
          const candidate = await this.candidateStore.getCandidateForOwner(ownerUserId, candidateId);
          if (!candidate) return `- proposalId=${candidateId}${subject} liveStatus=not_available`;
          const projection = projectPersonMemoryProposalStatus(candidate);
          return [
            `- proposalId=${projection.proposalId}${subject}`,
            `liveStatus=${projection.status}`,
            `publicationState=${projection.publicationState}`,
            `remainingDrafts=${projection.remainingDraftIds.length}`,
          ].join(' ');
        } catch {
          return `- proposalId=${candidateId}${subject} liveStatus=not_available reason=candidate_unavailable`;
        }
      }),
    );
    if (currentPrompt && !matchedPrompt && looksLikeProposalStatusQuestion(currentPrompt)) {
      lines.unshift('- requestedProposal=not_available reason=no_deterministic_subject_match_in_bounded_discovery');
    }

    return [
      '## F276 权威提案状态（服务端实时投影）',
      ...lines,
      '- 以上 liveStatus 来自本轮 invocation 前的 owner-private store，覆盖聊天卡片和历史回复里的旧状态。',
      '- 历史卡片状态不得作为当前状态；未列出或 not_available 的提案不得从聊天记录推断。',
    ].join('\n');
  }
}
