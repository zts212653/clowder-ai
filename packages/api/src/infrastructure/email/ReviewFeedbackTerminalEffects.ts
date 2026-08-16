import type { CommunityEvent, TaskItem } from '@cat-cafe/shared';
import type { ICommunityEventLog } from '../../domains/community/CommunityEventLog.js';
import type { DistillationCheckpoint } from '../distillation/DistillationCheckpoint.js';

export interface ReviewFeedbackTerminalEffectsOptions {
  readonly eventLog?: ICommunityEventLog;
  readonly projector?: { apply(event: CommunityEvent): Promise<void> };
  readonly distillationCheckpoint?: DistillationCheckpoint;
  readonly log: { warn: (...args: unknown[]) => void };
}

async function emitCommunityEvent(input: {
  readonly opts: ReviewFeedbackTerminalEffectsOptions;
  readonly subjectKey: string;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly terminalState: 'merged' | 'closed';
}): Promise<void> {
  if (!input.opts.eventLog) return;
  const kind: CommunityEvent['kind'] = input.terminalState === 'merged' ? 'pr.merged' : 'pr.closed';
  try {
    const event: CommunityEvent = {
      sourceEventId: `lifecycle:${input.subjectKey}:${input.terminalState}`,
      subjectKey: input.subjectKey,
      kind,
      classification: 'state-changing',
      payload: {
        prState: input.terminalState,
        repoFullName: input.repoFullName,
        prNumber: input.prNumber,
      },
      at: Date.now(),
    };
    const { appended } = await input.opts.eventLog.append(event);
    if (appended && input.opts.projector) await input.opts.projector.apply(event);
  } catch {
    input.opts.log.warn(`[review-feedback] community event emit failed for ${input.repoFullName}#${input.prNumber}`);
  }
}

async function emitDistillation(input: {
  readonly opts: ReviewFeedbackTerminalEffectsOptions;
  readonly task: TaskItem;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly terminalState: 'merged' | 'closed';
  readonly prTitle?: string;
}): Promise<void> {
  if (!input.opts.distillationCheckpoint || input.terminalState !== 'merged') return;
  try {
    const featureMatch = (input.prTitle ?? '').match(/\b[Ff](\d{2,4})\b/);
    if (!featureMatch) return;
    const phaseMatch = (input.prTitle ?? '').match(/[Pp]hase\s+([A-Z])/i);
    await input.opts.distillationCheckpoint.onFeatPhaseClose({
      prNumber: input.prNumber,
      repoFullName: input.repoFullName,
      authorCatId: input.task.ownerCatId ?? 'unknown',
      threadId: input.task.threadId,
      featureId: `F${featureMatch[1]}`,
      phaseLabel: phaseMatch?.[1] ?? 'unknown',
    });
  } catch {
    input.opts.log.warn(`[review-feedback] distillation checkpoint failed for ${input.repoFullName}#${input.prNumber}`);
  }
}

export async function projectReviewFeedbackTerminalEffects(input: {
  readonly opts: ReviewFeedbackTerminalEffectsOptions;
  readonly task: TaskItem;
  readonly subjectKey: string;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly terminalState: 'merged' | 'closed';
  readonly prTitle?: string;
}): Promise<void> {
  await emitCommunityEvent(input);
  await emitDistillation(input);
}
