import { createMicroduckOwnerAdapter } from './microduck-owner-adapter.js';
import type {
  MicroduckApprovalResolver,
  MicroduckBlocked,
  MicroduckCredentialBoundary,
  MicroduckOwnerPort,
  MicroduckProposalResolver,
} from './microduck-owner-contract.js';

export interface MicroduckOwnerRuntimeBindings {
  owner: MicroduckOwnerPort;
  credentialBoundary: MicroduckCredentialBoundary;
}

/**
 * Process-local composition only. The provider keeps canonical receipts and credentials; this seam
 * retains no owner state and remains blocked until an owner implementation connects at bootstrap.
 */
export class MicroduckOwnerRuntimeRegistration {
  private bindings?: MicroduckOwnerRuntimeBindings;

  connect(bindings: MicroduckOwnerRuntimeBindings): void {
    if (this.bindings) throw new Error('Microduck owner runtime is already connected');
    this.bindings = bindings;
  }

  snapshot(): MicroduckOwnerRuntimeBindings | undefined {
    return this.bindings;
  }
}

export const microduckOwnerRuntimeRegistration = new MicroduckOwnerRuntimeRegistration();

export interface MicroduckRuntimeAdapterOptions {
  registration?: Pick<MicroduckOwnerRuntimeRegistration, 'snapshot'>;
  approvalResolver?: MicroduckApprovalResolver;
  proposalResolver?: MicroduckProposalResolver;
}

async function guardedOwnerCall<T>(
  registration: Pick<MicroduckOwnerRuntimeRegistration, 'snapshot'>,
  invoke: (bindings: MicroduckOwnerRuntimeBindings) => Promise<T>,
  code: MicroduckBlocked['code'],
): Promise<T | MicroduckBlocked> {
  try {
    const bindings = registration.snapshot();
    return bindings ? await invoke(bindings) : { status: 'blocked', code };
  } catch {
    return { status: 'blocked', code };
  }
}

export function createMicroduckRuntimeAdapter(options: MicroduckRuntimeAdapterOptions = {}) {
  const registration = options.registration ?? microduckOwnerRuntimeRegistration;
  const owner: MicroduckOwnerPort = {
    async observe(input) {
      return guardedOwnerCall(registration, (bindings) => bindings.owner.observe(input), 'owner_route_unavailable');
    },
    async launchMutation(input) {
      return guardedOwnerCall(
        registration,
        (bindings) => bindings.owner.launchMutation(input),
        'owner_route_unavailable',
      );
    },
    async resolveVerification(input) {
      return guardedOwnerCall(
        registration,
        (bindings) => bindings.owner.resolveVerification(input),
        'owner_route_unavailable',
      );
    },
    async writeback(input) {
      return guardedOwnerCall(registration, (bindings) => bindings.owner.writeback(input), 'owner_route_unavailable');
    },
    async collectFreshOutcome(input) {
      return guardedOwnerCall(
        registration,
        (bindings) => bindings.owner.collectFreshOutcome(input),
        'owner_route_unavailable',
      );
    },
    async rollback(input) {
      return guardedOwnerCall(registration, (bindings) => bindings.owner.rollback(input), 'owner_route_unavailable');
    },
    async resolveShowState(input) {
      return guardedOwnerCall(
        registration,
        (bindings) => bindings.owner.resolveShowState(input),
        'owner_route_unavailable',
      );
    },
    async resolveShowMedia(input) {
      return guardedOwnerCall(
        registration,
        async (bindings) => {
          if (typeof bindings.owner.resolveShowMedia !== 'function') {
            return { status: 'blocked' as const, code: 'show_truth_incomplete' as const };
          }
          return bindings.owner.resolveShowMedia(input);
        },
        'show_truth_incomplete',
      );
    },
  };
  const credentialBoundary: MicroduckCredentialBoundary = {
    async authorize(input) {
      return guardedOwnerCall(
        registration,
        (bindings) => bindings.credentialBoundary.authorize(input),
        'permission_missing',
      );
    },
  };
  const approvalResolver: MicroduckApprovalResolver = options.approvalResolver ?? {
    async resolve() {
      return { status: 'blocked', code: 'approval_missing' };
    },
  };
  const proposalResolver: MicroduckProposalResolver = options.proposalResolver ?? {
    async resolve() {
      return { status: 'blocked', code: 'approval_missing' };
    },
  };
  return createMicroduckOwnerAdapter({ owner, credentialBoundary, approvalResolver, proposalResolver });
}
