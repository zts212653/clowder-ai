import type {
  EntrustedTaskDataControllerAuthority,
  EntrustedTaskDataControllerOwnerOperation,
  EntrustedTaskDataControllerTransitionResult,
} from '../cats/services/stores/ports/TaskDataControllerTransition.js';
import type { ITaskStore, TaskMutationWriteFence } from '../cats/services/stores/ports/TaskStoreContract.js';

const REQUIRED_GRANTS = ['task.read', 'task.write', 'task.admitEntrusted'] as const;

export interface VerifiedEntrustedTaskDataControllerAuthority {
  readonly ownerUserId: string;
  readonly controller: EntrustedTaskDataControllerAuthority;
  readonly effectiveGrants: readonly string[];
  readonly ownerOperation: EntrustedTaskDataControllerOwnerOperation & { readonly confirmed: true };
}

export interface BindEntrustedTaskDataControllerCommand {
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly operationId: string;
  readonly expected: {
    readonly ownerCatId: string;
    readonly threadId: string;
    readonly subjectKey: string;
    readonly firstSourceRef: string;
    readonly admissionAuthorityRef: string;
  };
}

export interface RevokeEntrustedTaskDataControllerCommand {
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly expectedBindingRevision: number;
  readonly expectedControllerReceiptRef: string;
  readonly operationId: string;
}

/** Owns the typed Task mutation; Host verification and inventory serialization stay outside this domain. */
export class EntrustedTaskDataControllerService {
  constructor(
    private readonly tasks: ITaskStore,
    private readonly writeFence?: TaskMutationWriteFence,
  ) {}

  bind(
    command: BindEntrustedTaskDataControllerCommand,
    authority: VerifiedEntrustedTaskDataControllerAuthority,
  ): EntrustedTaskDataControllerTransitionResult | Promise<EntrustedTaskDataControllerTransitionResult> {
    assertVerifiedAuthority(authority);
    return this.tasks.transitionEntrustedTaskDataController(
      {
        action: 'bind',
        taskId: command.taskId,
        expectedTaskRevision: command.expectedTaskRevision,
        operationId: command.operationId,
        expected: {
          userId: authority.ownerUserId,
          catId: command.expected.ownerCatId,
          threadId: command.expected.threadId,
          subjectKey: command.expected.subjectKey,
          firstSourceRef: command.expected.firstSourceRef,
          admissionAuthorityRef: command.expected.admissionAuthorityRef,
        },
        controller: authority.controller,
        ownerOperation: authority.ownerOperation,
      },
      this.writeFence,
    );
  }

  revoke(
    command: RevokeEntrustedTaskDataControllerCommand,
    authority: VerifiedEntrustedTaskDataControllerAuthority,
  ): EntrustedTaskDataControllerTransitionResult | Promise<EntrustedTaskDataControllerTransitionResult> {
    assertVerifiedAuthority(authority);
    return this.tasks.transitionEntrustedTaskDataController(
      {
        action: 'revoke',
        taskId: command.taskId,
        expectedTaskRevision: command.expectedTaskRevision,
        expectedBindingRevision: command.expectedBindingRevision,
        expectedControllerReceiptRef: command.expectedControllerReceiptRef,
        operationId: command.operationId,
        controller: authority.controller,
        ownerOperation: authority.ownerOperation,
      },
      this.writeFence,
    );
  }
}

function assertVerifiedAuthority(authority: VerifiedEntrustedTaskDataControllerAuthority): void {
  if (!authority.ownerOperation.confirmed) throw new Error('Task data controller requires a confirmed owner operation');
  if (authority.ownerOperation.actorRef !== `user:${authority.ownerUserId}`) {
    throw new Error('Task data controller owner operation does not match the installation owner');
  }
  const missing = REQUIRED_GRANTS.find((grant) => !authority.effectiveGrants.includes(grant));
  if (missing) throw new Error(`Task data controller requires ${missing}`);
}
