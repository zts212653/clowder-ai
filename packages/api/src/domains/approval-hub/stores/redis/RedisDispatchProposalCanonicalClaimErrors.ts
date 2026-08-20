import type { NegativeAuthorizationProposalStatus } from '../ports/IDispatchProposalStore.js';

export class RedisCanonicalAdmissionBlockedError extends Error {
  readonly proposalIds: string[];
  readonly status: NegativeAuthorizationProposalStatus;
  readonly legacyBlockPresent: boolean;

  constructor(
    readonly proposalStatuses: ReadonlyArray<{
      proposalId: string;
      status: NegativeAuthorizationProposalStatus;
    }>,
    readonly legacyUnresolved = false,
    readonly legacyCutoverAt?: number,
    legacyBlockPresent = legacyUnresolved,
  ) {
    const first = proposalStatuses[0];
    if (!first) throw new Error('canonical admission blocker must include at least one proposal');
    const proposalIds = proposalStatuses.map(({ proposalId }) => proposalId);
    const status = first.status;
    super(`canonical admission blocked by ${proposalIds.join(', ')}`);
    this.proposalIds = proposalIds;
    this.status = status;
    this.legacyBlockPresent = legacyBlockPresent;
    this.name = 'RedisCanonicalAdmissionBlockedError';
  }
}
