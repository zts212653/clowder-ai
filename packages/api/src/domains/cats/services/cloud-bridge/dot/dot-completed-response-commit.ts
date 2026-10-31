import { type CatId, createCatId } from '@cat-cafe/shared';
import {
  type AppendMessageInput,
  LifecycleResponseInputsChangedError,
  type StoredMessage,
} from '../../stores/ports/MessageStore.js';
import { type DotCompletedReplySourceInput, readDotCompletedReplySnapshot } from './dot-completed-reply-source.js';
import type { DotReplyCandidate } from './dot-reply-authority.js';

/** Refresh the source only on the existing terminal transaction's input-set CAS conflict.
 * No output/wake can commit from a source snapshot that predates an admitted Append.
 */
export async function commitDotCompletedResponse(
  input: DotCompletedReplySourceInput & {
    message: AppendMessageInput;
    targetCats: readonly CatId[];
    replyTarget: (source: DotReplyCandidate) => Promise<boolean>;
    commit: (
      message: AppendMessageInput,
      targets: CatId[],
      expectedInputs: readonly string[] | undefined,
    ) => Promise<StoredMessage>;
  },
): Promise<StoredMessage> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await readDotCompletedReplySnapshot(input);
    const sourceId = snapshot.sourceMessageId;
    const replyTo = sourceId === input.triggerMessageId ? input.message.replyTo : sourceId;
    const candidate = {
      userId: input.userId,
      threadId: input.threadId,
      catId: createCatId(input.catId),
      replyTo,
      extra: sourceId ? { causal: { kind: 'invocation_reply' as const, triggerMessageId: sourceId } } : undefined,
    };
    const targets = [...input.targetCats];
    let message = input.message;
    if (sourceId && (await input.replyTarget(candidate))) {
      if (!targets.includes(createCatId('gpt-dot'))) targets.push(createCatId('gpt-dot'));
      message = {
        ...message,
        mentions: targets,
        ...(replyTo ? { replyTo } : {}),
        extra: { ...message.extra, ...candidate.extra },
      };
    }
    try {
      return await input.commit(message, targets, snapshot.inputMessageIds);
    } catch (error) {
      if (!(error instanceof LifecycleResponseInputsChangedError)) throw error;
    }
  }
  throw new Error('canonical response inputs kept changing at terminal commit; terminal commit rejected');
}
