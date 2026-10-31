import { useApprovalHost } from '@/components/ApprovalHost';
import { useShellPresentation } from '../shell/shell-presentation';
import { ProposalCardClassic } from './ProposalCardClassic';
import { ProposalCardMailbox } from './ProposalCardMailbox';
import { ProposalCardV2 } from './ProposalCardV2';
import { type ProposalCardInput, useProposalCardState } from './useProposalCardState';

/** Both placements use this producer controller and the original action writers. */
export function ProposalCardProducer(props: ProposalCardInput & { showTitle?: boolean }) {
  const state = useProposalCardState(props);
  const host = useApprovalHost();
  const shell = useShellPresentation();
  return props.proposal ? (
    shell === 'v2' ? (
      <ProposalCardV2 proposal={props.proposal} state={state} host={host} />
    ) : (
      <ProposalCardMailbox proposal={props.proposal} state={state} host={host} showTitle={props.showTitle} />
    )
  ) : (
    <ProposalCardClassic block={props.block} state={state} />
  );
}
