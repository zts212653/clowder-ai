import { useApprovalHost } from '@/components/ApprovalHost';
import { ProposalCardClassic } from './ProposalCardClassic';
import { ProposalCardMailbox } from './ProposalCardMailbox';
import { type ProposalCardInput, useProposalCardState } from './useProposalCardState';

/** Both placements use this producer controller and the original action writers. */
export function ProposalCardProducer(props: ProposalCardInput & { showTitle?: boolean }) {
  const state = useProposalCardState(props);
  const host = useApprovalHost();
  return props.proposal ? (
    <ProposalCardMailbox proposal={props.proposal} state={state} host={host} showTitle={props.showTitle} />
  ) : (
    <ProposalCardClassic block={props.block} state={state} />
  );
}
