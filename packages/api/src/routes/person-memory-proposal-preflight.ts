import {
  PERSON_MEMORY_LIMITS,
  type PersonMemoryProposalPreflightBlock,
  type PersonMemoryProposalPreflightBudget,
  type RichPersonMemoryProposalCardBlock,
} from '@cat-cafe/shared';
import type { ZodIssue } from 'zod';
import { projectCandidateInteractionInformedEvidence } from '../domains/memory/people/PersonMemoryInformedEvidence.js';
import type { StoredPersonMemoryCandidate } from '../domains/memory/people/PersonMemoryStore.js';
import { estimateTokens } from '../utils/token-counter.js';
import { buildPersonMemoryProposalCard, personMemoryProposalCardText } from './person-memory-proposal-card.js';

export type PersonMemoryCardPreflight =
  | {
      status: 'ready';
      card: RichPersonMemoryProposalCardBlock;
      estimatedTokens: number;
      maxTokens: number;
    }
  | {
      status: 'blocked';
      preflight: PersonMemoryProposalPreflightBlock;
    };

export type PersonMemoryProposalFailure = {
  statusCode: 400 | 404 | 409 | 422 | 503;
  payload: Record<string, unknown>;
};

type SchemaPreflightEntry = {
  issue: PersonMemoryProposalPreflightBlock['issues'][number];
  budget?: PersonMemoryProposalPreflightBudget;
};

export function personMemoryPreflightBlock(
  phase: PersonMemoryProposalPreflightBlock['phase'],
  issue: PersonMemoryProposalPreflightBlock['issues'][number],
  budget?: PersonMemoryProposalPreflightBlock['budget'],
): PersonMemoryProposalPreflightBlock {
  return {
    status: 'blocked',
    phase,
    issues: [issue],
    ...(budget ? { budget } : {}),
  };
}

function issuePath(issue: ZodIssue): string | undefined {
  return issue.path.length > 0 ? issue.path.map(String).join('.') : undefined;
}

function schemaPreflightEntry(issue: ZodIssue): SchemaPreflightEntry | null {
  if (issue.code !== 'custom') return null;
  const params: Record<string, unknown> = issue.params ?? {};
  const code = params.preflightCode;
  const path = issuePath(issue);
  if (code === 'informed_approval_incomplete') {
    return {
      issue: {
        code,
        message: '人物记忆提案必须包含 1–3 个可逐项审批的内容。',
        action: '保留 1–3 个 exact-bind items 后重新提交。',
        ...(path ? { path } : {}),
      },
    };
  }
  if (code !== 'evidence_excerpt_budget_exceeded') return null;
  const budgetKind = params.budgetKind;
  const maxTokens = params.maxTokens;
  if (
    (budgetKind !== 'evidence_excerpt' && budgetKind !== 'evidence_excerpt_aggregate') ||
    typeof maxTokens !== 'number'
  ) {
    return null;
  }
  return {
    issue: {
      code,
      message: `证据摘录超出 ${maxTokens} token 上限。`,
      action:
        budgetKind === 'evidence_excerpt' ? '缩短每段证据摘录后重新提交。' : '减少或缩短证据摘录，使总量回到上限内。',
      ...(path ? { path } : {}),
    },
    budget: { kind: budgetKind, maxTokens },
  };
}

export function proposalSchemaPreflight(issues: ZodIssue[]): PersonMemoryProposalPreflightBlock | null {
  const known = issues.map(schemaPreflightEntry).filter((entry): entry is SchemaPreflightEntry => entry !== null);
  if (known.length === 0 || known.length !== issues.length) return null;
  const budget = known.find((entry) => entry.budget)?.budget;
  return {
    status: 'blocked',
    phase: 'informed_approval',
    issues: known.map((entry) => entry.issue),
    ...(budget ? { budget } : {}),
  };
}

export function proposalPreflightFailure(
  error: string,
  phase: PersonMemoryProposalPreflightBlock['phase'],
  issue: PersonMemoryProposalPreflightBlock['issues'][number],
  extras: Record<string, unknown> = {},
): PersonMemoryProposalFailure {
  return {
    statusCode: 400,
    payload: {
      error,
      ...extras,
      preflight: personMemoryPreflightBlock(phase, issue),
    },
  };
}

function informedApprovalBlock(): PersonMemoryCardPreflight {
  return {
    status: 'blocked',
    preflight: personMemoryPreflightBlock('informed_approval', {
      code: 'informed_approval_incomplete',
      message: '互动记忆缺少可供审批者理解的字段与证据映射。',
      action: '为每个互动事实字段绑定 owner-confirmed evidence，再重新提交。',
      path: 'interaction',
    }),
  };
}

export function preflightPersonMemoryProposalCard(candidate: StoredPersonMemoryCandidate): PersonMemoryCardPreflight {
  const interaction = candidate.interactionDraft;
  if (
    interaction &&
    candidate.remainingDraftIds.includes(interaction.draftId) &&
    interaction.sourceEvidence.length === 0 &&
    projectCandidateInteractionInformedEvidence(candidate, interaction.draftId).length === 0
  ) {
    return informedApprovalBlock();
  }
  const card = buildPersonMemoryProposalCard(candidate);
  const estimatedTokens = estimateTokens(personMemoryProposalCardText(card));
  const maxTokens = PERSON_MEMORY_LIMITS.maxCandidateCardTokens;
  if (estimatedTokens > maxTokens) {
    return {
      status: 'blocked',
      preflight: personMemoryPreflightBlock(
        'card_budget',
        {
          code: 'card_token_budget_exceeded',
          message: `审批卡超出 ${maxTokens} token 上限。`,
          action: '拆成更少的 exact-bind items，或精简重复的展示文本后重新提交。',
        },
        { kind: 'candidate_card', estimatedTokens, maxTokens },
      ),
    };
  }
  return { status: 'ready', card, estimatedTokens, maxTokens };
}
