import { type CollectiveComposerVoiceDraft, collectiveComposerDraftSchema } from '@cat-cafe/shared';
import type { ComposerDraft } from './composer-draft.js';
import type { MessageExpressionPort } from './message-expression-context.js';

export function updateComposerVoice(
  draft: ComposerDraft,
  captureId: string,
  voice: Partial<CollectiveComposerVoiceDraft>,
): ComposerDraft {
  return draft.voiceDraft?.captureId === captureId
    ? { ...draft, voiceDraft: { ...draft.voiceDraft, ...voice } }
    : draft;
}
export function applyComposerTranscript(draft: ComposerDraft, captureId: string, transcript: string): ComposerDraft {
  if (draft.voiceDraft?.captureId !== captureId || draft.voiceDraft.applied) return draft;
  const body = draft.body ? `${draft.body}\n${transcript}` : transcript;
  return {
    ...draft,
    ...(body.length <= 32_000 ? { body } : {}),
    voiceDraft: { captureId, transcript, state: 'ready', applied: body.length <= 32_000 },
  };
}

/** The captured Human/Channel port stays fixed. A newer draft is never replaced by a late transcription. */
export async function publishComposerTranscript(
  port: MessageExpressionPort,
  channelId: string,
  rootEventId: string | undefined,
  captureId: string,
  transcript: string,
  expectedRevision?: number,
) {
  const { draft } = await port.channelState(channelId, rootEventId);
  if (draft.content.voiceDraft?.captureId !== captureId || draft.content.voiceDraft.applied)
    return { status: 'stored' as const, draft };
  if (expectedRevision !== undefined && draft.revision !== expectedRevision)
    return { status: 'conflict' as const, draft };
  const content = collectiveComposerDraftSchema.parse(applyComposerTranscript(draft.content, captureId, transcript));
  return port.saveDraft(channelId, rootEventId, content, draft.revision, `voice:${captureId}:transcript`);
}
