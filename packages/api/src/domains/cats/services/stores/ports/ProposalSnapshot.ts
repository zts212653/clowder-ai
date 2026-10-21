import type { ProposalApproveOverrides, ThreadProposal } from '@cat-cafe/shared';

export function applyProposalOverrides(
  proposal: ThreadProposal,
  overrides: ProposalApproveOverrides | undefined,
): void {
  if (!overrides) return;
  if (overrides.title !== undefined) proposal.title = overrides.title;
  if (overrides.parentThreadId !== undefined) proposal.parentThreadId = overrides.parentThreadId;
  if (overrides.preferredCats !== undefined) proposal.preferredCats = [...overrides.preferredCats];
  if (overrides.projectPath !== undefined) proposal.projectPath = overrides.projectPath;
  if (overrides.reportingMode !== undefined) proposal.reportingMode = overrides.reportingMode;
  if (overrides.declaredWorkMode !== undefined) proposal.declaredWorkMode = overrides.declaredWorkMode;
  if (overrides.initialMessage === null) delete proposal.initialMessage;
  else if (typeof overrides.initialMessage === 'string') proposal.initialMessage = overrides.initialMessage;
}

export function cloneProposal(proposal: ThreadProposal): ThreadProposal {
  return {
    ...proposal,
    preferredCats: [...proposal.preferredCats],
    ...(proposal.publication ? { publication: structuredClone(proposal.publication) } : {}),
    ...(proposal.approvedTaskContract ? { approvedTaskContract: { ...proposal.approvedTaskContract } } : {}),
    ...(proposal.taskContractContinuation
      ? { taskContractContinuation: structuredClone(proposal.taskContractContinuation) }
      : {}),
    // F167 R5: approvedDevelopmentScope is an authorization snapshot — must be isolated
    // from the store's internal copy. All fields are primitives, so spread suffices.
    ...(proposal.approvedDevelopmentScope
      ? { approvedDevelopmentScope: { ...proposal.approvedDevelopmentScope } }
      : {}),
  };
}
