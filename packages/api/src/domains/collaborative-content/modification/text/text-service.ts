import { respondContentTextSchema } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type {
  MediaReviewPrincipal,
  PublishedMediaAccess,
} from '../../../video-studio/content-owner/published-media-access.js';
import type { WorkspaceContentSourceService } from '../../../workspace/workspace-content-source.js';
import type { TextModificationReturnIntent } from '../../artifact-review/return-store.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';
import { assertModificationSourceAuthority } from '../request-authority.js';
import { ModificationTextExecution } from './text-execution.js';
import { applyContentTextEdits, ModificationTextError } from './text-store.js';

export class ContentTextModificationService {
  private readonly execution: ModificationTextExecution;
  constructor(
    private readonly deps: {
      store: ArtifactReviewStore;
      access: PublishedMediaAccess;
      source: WorkspaceContentSourceService;
      messages: Pick<IMessageStore, 'getById'>;
      executionDirectory: string;
    },
  ) {
    this.execution = new ModificationTextExecution(deps.executionDirectory);
  }

  async read(requestId: string, principal: MediaReviewPrincipal) {
    const { record, source, task, current } = await this.authorize(requestId, principal, true);
    const proposals = this.deps.store.text.proposals(requestId);
    const execution = principal.actor.kind === 'cat' ? await this.execution.prepare(source) : undefined;
    return {
      record,
      source,
      proposals,
      rejections: this.deps.store.acceptances.rejections(requestId, principal.userId),
      taskRevision: task.entrustedWork?.revision,
      currentRevision: current.revision,
      ...(execution ? { execution } : {}),
    };
  }

  async respond(raw: unknown, principal: MediaReviewPrincipal) {
    const command = respondContentTextSchema.parse(raw);
    if (principal.actor.kind !== 'cat') throw new ModificationTextError('not_found');
    const { source, task } = await this.authorize(command.requestId, principal, true);
    const old = this.deps.store.text
      .proposals(command.requestId)
      .find((item) => item.operationId === command.operationId);
    if (
      !old &&
      (task.status === 'done' ||
        task.entrustedWork?.closure.state !== 'open' ||
        task.entrustedWork.revision !== command.expectedTaskRevision)
    )
      throw new ModificationTextError('task_changed');
    const proposal = this.deps.store.text.respond(command, principal.actor.actorId);
    const candidatePath = await this.execution.materialize(source, proposal);
    return { proposal, candidatePath };
  }

  async candidate(requestId: string, proposalRef: string, principal: MediaReviewPrincipal) {
    const { source } = await this.authorize(requestId, principal, true);
    const proposal = this.deps.store.text.proposals(requestId).find((item) => item.proposalRef === proposalRef);
    if (!proposal) throw new ModificationTextError('not_found');
    return { proposal, bytes: Buffer.from(applyContentTextEdits(source.text, proposal.edits)), source: source.source };
  }

  async isCurrent(intent: TextModificationReturnIntent): Promise<boolean> {
    const { record, source, task } = await this.authorize(
      intent.requestId,
      { userId: intent.ownerUserId, threadId: intent.threadId, actor: { kind: 'cat', actorId: intent.targetCatId } },
      false,
    );
    return (
      record.progress.review?.receiptRef === intent.receiptRef &&
      task.entrustedWork?.revision === intent.expectedTaskRevision &&
      source.source.revision === intent.baseRevision &&
      this.deps.store.text.proposals(intent.requestId).length === 0
    );
  }

  private async authorize(requestId: string, principal: MediaReviewPrincipal, allowClosed: boolean) {
    const record = this.deps.store.requests.get(requestId, principal.userId),
      source = this.deps.store.text.source(requestId);
    const taskRef = record?.progress.task;
    if (!record || !source || source.ownerUserId !== principal.userId || !taskRef || !record.progress.review)
      throw new ModificationTextError('not_found');
    const task = await this.deps.access.authorize(taskRef.taskId, principal, { allowClosed });
    if (
      task.ownerCatId !== record.payload.targetCatId ||
      task.threadId !== record.payload.threadId ||
      (principal.actor.kind === 'cat' && principal.actor.actorId !== task.ownerCatId)
    )
      throw new ModificationTextError('task_changed');
    await assertModificationSourceAuthority(this.deps.messages, record);
    const current = await this.deps.source.describe({ principal, locator: source.source.locator });
    return { record, source, task, current };
  }
}
