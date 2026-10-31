import { readMessageOutputLayout } from '@cat-cafe/shared';
import type { ChatMessage } from './chat-types';

/** Optional native-only metadata cannot lend proof to callbacks or another child. */
export function withoutUnprovenOutputLayout(record: ChatMessage): ChatMessage {
  if (!record.extra?.outputLayout) return record;
  const layout = readMessageOutputLayout(record.extra.outputLayout);
  const allowed =
    record.type === 'assistant' &&
    record.origin === 'stream' &&
    !record.extra.isExplicitPost &&
    layout !== undefined &&
    layout.owner.catId === record.catId &&
    layout.owner.turnInvocationId ===
      (record.lifecycle?.kind === 'response'
        ? record.lifecycle.invocationId
        : (record.extra?.stream?.turnInvocationId ?? record.extra?.stream?.invocationId)) &&
    layout.contentRevision.length === record.content.length;
  if (allowed) return record;
  const extra = { ...record.extra };
  delete extra.outputLayout;
  return { ...record, extra };
}
