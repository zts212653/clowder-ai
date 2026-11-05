type OptionalDecisionFacts = {
  status: string;
  approvedAt?: number;
  approvedBy?: string;
  rejectedAt?: number;
  rejectedBy?: string;
  withdrawnAt?: number;
  withdrawnBy?: string;
};

/** Missing legacy facts stay unknown; neither ownership nor another status proves a decision. */
export function projectSettledDecisionFacts(proposal: OptionalDecisionFacts) {
  let at: number | undefined;
  let by: string | undefined;
  switch (proposal.status) {
    case 'approved':
      [at, by] = [proposal.approvedAt, proposal.approvedBy];
      break;
    case 'rejected':
      [at, by] = [proposal.rejectedAt, proposal.rejectedBy];
      break;
    case 'withdrawn':
      [at, by] = [proposal.withdrawnAt, proposal.withdrawnBy];
      break;
    default:
      throw new Error(`unsupported settled decision: ${proposal.status}`);
  }
  const decidedAt = typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0;
  return {
    decidedAt,
    decidedBy: by ?? '',
    detail: decidedAt > 0 ? {} : { closureTimeUnknown: true },
  };
}
