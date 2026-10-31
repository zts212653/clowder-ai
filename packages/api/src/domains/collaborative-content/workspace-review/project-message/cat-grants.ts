import { isDeepStrictEqual } from 'node:util';
import type { TurnExecutionRecord, WorkspaceContentAnnotation } from '@cat-cafe/shared';
import {
  deriveGrowingSourceMessageRevision,
  type StoredMessage,
} from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../../../cats/services/stores/ports/TurnExecutionStore.js';
import type { AuthorizeVideoProjectCat, VideoProjectPrincipal } from '../../../video-studio/project/access.js';
import { WorkspaceContentReviewError } from '../errors.js';
import type { WorkspaceContentReviewStore } from '../store.js';
import { projectMessageAttachments } from './import.js';
import type { VideoProjectMessageAuthority } from './types.js';
import { isDeliveredProjectHuman, projectMessageAnnotationProjection } from './visibility.js';

export interface ProjectMessageGrantWitness {
  readonly principal: VideoProjectPrincipal;
  readonly contentRef: string;
  readonly threadId: string;
  readonly sourceMessageId: string;
  readonly sourceMessageRevision: string;
  readonly annotationIds: readonly string[];
}
/** Must verify a current, same-source, same-cat F309 takeover in the canonical journal. A role is not a grant. */
export interface ProjectMessageTakeoverGrantPort {
  hasGrant(witness: ProjectMessageGrantWitness): Promise<boolean>;
}

/** Authenticated callback principal → exact running child → original Human request → retained import facts. */
export class ProjectMessageCatGrants {
  readonly authorize: AuthorizeVideoProjectCat;
  constructor(
    private readonly deps: {
      turns: Pick<ITurnExecutionStore, 'get'>;
      authority: VideoProjectMessageAuthority;
      ledgers: Pick<WorkspaceContentReviewStore, 'getByContent'>;
      takeover?: ProjectMessageTakeoverGrantPort;
    },
  ) {
    this.authorize = async ({ principal, contentRef, permission }) => {
      const witness = await this.selectWitness(principal, contentRef, permission === 'write');
      await this.deps.authority.authorizeSource({
        principal,
        threadId: witness.threadId,
        messageId: witness.sourceMessageId,
        permission,
      });
      await this.requireChild(principal);
      const current = await this.deps.authority.messages.getById(witness.sourceMessageId);
      if (
        !originalRequest(current, principal, witness.threadId) ||
        deriveGrowingSourceMessageRevision(current) !== witness.sourceMessageRevision
      )
        denied();
      // The original-message read is awaited too; the same-source Task must still grant the write afterwards.
      if (permission === 'write' && !(await this.deps.takeover?.hasGrant(witness))) denied();
    };
  }

  sourceWitness(principal: VideoProjectPrincipal, contentRef: string, permission: 'read' | 'write' = 'write') {
    return this.selectWitness(principal, contentRef, permission === 'write');
  }

  private async selectWitness(principal: VideoProjectPrincipal, contentRef: string, accepted: boolean) {
    const candidates = await this.witnesses(principal, contentRef);
    for (const witness of candidates) if (!accepted || (await this.deps.takeover?.hasGrant(witness))) return witness;
    denied();
  }

  private async requireChild(principal: VideoProjectPrincipal): Promise<TurnExecutionRecord> {
    if (principal.actor.kind !== 'cat' || !principal.invocationId) denied();
    const turn = await this.deps.turns.get(principal.invocationId);
    if (
      !turn ||
      turn.invocationId !== principal.invocationId ||
      turn.userId !== principal.userId ||
      turn.catId !== principal.actor.actorId ||
      turn.status !== 'running'
    )
      denied();
    return turn;
  }

  private async witnesses(principal: VideoProjectPrincipal, contentRef: string): Promise<ProjectMessageGrantWitness[]> {
    const turn = await this.requireChild(principal);
    const review = this.deps.ledgers.getByContent(principal.userId, contentRef);
    if (!review || review.source.kind !== 'video-project') denied();
    const candidates = new Set([turn.causal?.triggerMessageId, ...(turn.causal?.coveredMessageIds ?? [])]);
    const groups = new Map<string, { revision: string; ids: string[] }>();
    for (const annotation of review.annotations) {
      const context = annotation.projectMessage;
      if (!context || !candidates.has(context.source.messageId) || context.source.threadId !== turn.threadId) continue;
      if (!(await this.matchesAnnotation(annotation, principal, contentRef, turn.threadId))) continue;
      const group = groups.get(context.source.messageId) ?? { revision: context.source.messageRevision, ids: [] };
      group.ids.push(annotation.id);
      groups.set(context.source.messageId, group);
    }
    if (!groups.size) denied();
    return [...groups].map(([sourceMessageId, group]) => ({
      principal,
      contentRef,
      threadId: turn.threadId,
      sourceMessageId,
      sourceMessageRevision: group.revision,
      annotationIds: group.ids,
    }));
  }

  private async matchesAnnotation(
    annotation: WorkspaceContentAnnotation,
    principal: VideoProjectPrincipal,
    contentRef: string,
    threadId: string,
  ) {
    const context = annotation.projectMessage;
    if (!context || !(await projectMessageAnnotationProjection(annotation, principal, this.deps.authority)))
      return false;
    const source = await this.deps.authority.messages.getById(context.source.messageId);
    if (
      !originalRequest(source, principal, threadId) ||
      deriveGrowingSourceMessageRevision(source) !== context.source.messageRevision
    )
      return false;
    const attachment = projectMessageAttachments(source).find((item) => item.id === context.source.attachmentId);
    const selection = attachment?.selections.find((item) => item.id === context.source.selectionId);
    if (!attachment || !selection) return false;
    return isDeepStrictEqual(
      {
        contentRef: attachment.contentRef,
        screeningId: attachment.screeningId,
        input: attachment.input,
        media: attachment.media,
        target: selection.target,
        mediaRange: selection.mediaRange,
        body: (selection.comment ?? source.content).trim(),
      },
      {
        contentRef,
        screeningId: context.screeningId,
        input: context.input,
        media: context.media,
        target: context.selection.target,
        mediaRange: context.selection.mediaRange,
        body: annotation.body,
      },
    );
  }
}
function originalRequest(
  source: StoredMessage | null,
  principal: VideoProjectPrincipal,
  threadId: string,
): source is StoredMessage {
  return (
    source !== null &&
    isDeliveredProjectHuman(source, principal.userId) &&
    source.threadId === threadId &&
    source.mentions.some((catId) => catId === principal.actor.actorId) &&
    (source.visibility !== 'whisper' || Boolean(source.whisperTo?.some((catId) => catId === principal.actor.actorId)))
  );
}
function denied(): never {
  throw new WorkspaceContentReviewError('access_denied');
}
