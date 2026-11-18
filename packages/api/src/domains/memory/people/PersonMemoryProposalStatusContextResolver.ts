import { captureCandidateIdSchema, isPersonMemoryProposalCardBlock } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { PersonMemoryStore } from './PersonMemoryStore.js';
import { normalizePrivateAlias } from './person-memory-keys.js';
import { PERSON_MEMORY_PROPOSAL_STATUS_TOOL } from './person-memory-proposal-card-pointer.js';
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

/** Proposals the prompt names come first, so the context cap never cuts them out. */
function rankProposalReferences(proposals: readonly ProposalReference[], currentPrompt: string): ProposalReference[] {
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
  return [...requested, ...proposals.filter((proposal) => !requestedIds.has(proposal.candidateId))].slice(
    0,
    PROPOSAL_CONTEXT_LIMIT,
  );
}

function subjectField(subjectDisplayName: string | undefined): string {
  return subjectDisplayName ? ` subject=${JSON.stringify(subjectDisplayName)}` : '';
}

const HEADING = '## F276 权威提案状态（服务端实时投影）';

/**
 * F276 status-answer guard.
 *
 * The resolver detects typed F276 cards from persisted message metadata and
 * reads their current owner-scoped candidates before every model invocation.
 * Historical card metadata is deliberately ignored after candidate discovery.
 *
 * What it says follows the cards it finds, never the wording of the prompt: no
 * card in the window, no block. The per-turn history digest names the proposal
 * and the live status tool on each card it renders
 * (personMemoryProposalCardPointer). Not covered: card text already frozen in a
 * live session (accepted by the owner on 2026-11-16), and cards that arrive
 * through forwarded or quoted message bundles or message-read tools.
 */
export class PersonMemoryProposalStatusContextResolver {
  constructor(
    private readonly candidateStore: Pick<PersonMemoryStore, 'getCandidateForOwner'> | null,
    private readonly messageStore: Pick<IMessageStore, 'getByThread'>,
  ) {}

  async resolve(ownerUserId: string, threadId: string, currentPrompt = ''): Promise<string> {
    let messages: readonly StoredMessage[];
    try {
      // Keep the bounded reverse timeline and full rich-card metadata, but leave
      // unrelated top-level bodies and tool payloads in storage.
      messages = await this.messageStore.getByThread(threadId, MESSAGE_DISCOVERY_LIMIT, ownerUserId, {
        artifactProjection: true,
      });
    } catch {
      return `人物记忆提案：本轮没读到线程历史（reason=message_history_unavailable），这里给不出现状；要答这类提案的状态，用 proposalId 调 ${PERSON_MEMORY_PROPOSAL_STATUS_TOOL} 查。`;
    }

    const proposals = proposalReferencesFromMessages(messages);
    if (proposals.length === 0) return '';
    const selected = rankProposalReferences(proposals, currentPrompt);

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
    return [
      HEADING,
      ...lines,
      `- 以上是本轮刚读到的现状；聊天里的旧卡片、旧回复与它不一致时以这里为准。没列出或 not_available 的提案，用 proposalId 调 ${PERSON_MEMORY_PROPOSAL_STATUS_TOOL} 查。`,
    ].join('\n');
  }
}
