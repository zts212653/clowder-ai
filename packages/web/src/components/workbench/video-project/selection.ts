import {
  ContextAttachmentsSchema,
  displayRegionToProjectCanvas,
  mapScreeningMediaRange,
  type ProjectScreeningContextAttachment,
  projectScreeningContextAttachmentSchema,
  type VideoProjectDocumentV1,
  type VideoProjectReviewRegion,
  type VideoProjectReviewTarget,
  type VideoProjectScreening,
} from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { composerAttachments, queuedServerAckBlocks } from '../../composer-queue';
import { projectScreeningComposerConflict } from '../../project-screening-composer-group';

export function screeningSelection(input: {
  screening: VideoProjectScreening;
  document: VideoProjectDocumentV1;
  mediaRange: { startPts: number; endPts: number };
  mode: 'moment' | 'segment' | 'project';
  displayRegion?: VideoProjectReviewRegion;
}) {
  const mapped = mapScreeningMediaRange(input.screening, input.mediaRange);
  let target: VideoProjectReviewTarget = { kind: 'project' };
  const canvasRegion = input.displayRegion ? displayRegionToProjectCanvas(input.screening, input.displayRegion) : null;
  if (input.displayRegion && !canvasRegion) throw new Error('选区不在影片画面内');
  if (mapped && input.mode !== 'project') {
    const segment = input.document.timeline.segments.find(
      (item) => item.startTick <= mapped.startTick && item.startTick + item.durationTicks >= mapped.endTick,
    );
    target =
      input.mode === 'segment' && segment
        ? { kind: 'segment', segmentId: segment.id }
        : {
            kind: 'moment',
            tick: mapped.startTick,
            endTick: mapped.endTick,
            timebase: input.document.timeline.timebase,
            ...(canvasRegion ? { region: canvasRegion } : {}),
          };
  }
  return {
    id: crypto.randomUUID(),
    mediaRange: input.mediaRange,
    target,
    ...(input.displayRegion ? { displayRegion: input.displayRegion } : {}),
    ...(canvasRegion ? { canvasRegion } : {}),
  };
}

/** Queues one immutable position chip; only the original Human send creates a message/ledger fact. */
export function queueScreeningSelection(threadId: string | null, attachment: ProjectScreeningContextAttachment) {
  if (!threadId) return { kind: 'refused' as const, reason: '先打开一条对话，再记下意见。' };
  if (queuedServerAckBlocks()) return { kind: 'refused' as const, reason: '输入框正在恢复，请稍后再记下位置。' };
  const parsed = projectScreeningContextAttachmentSchema.parse(attachment);
  const queued = useChatStore.getState().pendingChatInsert;
  if (queued && queued.threadId !== threadId)
    return { kind: 'refused' as const, reason: '另一条对话的内容正在排入输入框，请稍后再记下。' };
  const effective = [...composerAttachments(threadId), parsed];
  const conflict = projectScreeningComposerConflict(effective);
  if (conflict) return { kind: 'refused' as const, reason: conflict };
  if (!ContextAttachmentsSchema.safeParse(effective).success)
    return { kind: 'refused' as const, reason: '输入框上下文过多，请先发送或移除。' };
  const base = queued?.threadId === threadId ? queued : { threadId, text: '' };
  useChatStore
    .getState()
    .setPendingChatInsert({ ...base, contextAttachments: [...(base.contextAttachments ?? []), parsed] });
  return { kind: 'queued' as const };
}
