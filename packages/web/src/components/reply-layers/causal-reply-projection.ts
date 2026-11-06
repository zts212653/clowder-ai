import { getLifecycleAppendOutcome } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';

export interface CausalReplySlice {
  response: ChatMessage;
  inputMessageId: string;
  start: number;
  end: number;
  nextInputMessageId?: string;
}

export function causalBoundaryKey(
  response: ChatMessage,
  boundary: { inputMessageId: string; contentOffset: number; prefixSha256: string },
) {
  return `${response.id}:${response.lifecycle?.kind === 'response' ? response.lifecycle.invocationId : ''}:${boundary.inputMessageId}:${boundary.contentOffset}:${boundary.prefixSha256}`;
}

/** The proof is tied to the actual prefix, so a later body replacement cannot reuse it. */
export function projectCausalReplies(messages: readonly ChatMessage[], verified: ReadonlyMap<string, string>) {
  const originals = new Map<string, { start: number; end: number; inputMessageId: string }>();
  const continuations = new Map<string, CausalReplySlice[]>();
  const sources = new Map(messages.map((message, position) => [message.id, { message, position }]));
  messages.forEach((response, responseIndex) => {
    const lifecycle = response.lifecycle;
    if (
      lifecycle?.kind !== 'response' ||
      !lifecycle.appendBoundaries?.length ||
      response.origin !== 'stream' ||
      response.type !== 'assistant' ||
      response.visibility === 'whisper' ||
      response.extra?.recall ||
      response.contentBlocks?.length ||
      response.extra?.isExplicitPost
    )
      return;
    const content = response.content.trimStart();
    const leading = response.content.length - content.length;
    const boundaries = lifecycle.appendBoundaries;
    if (
      !boundaries.every((boundary, index) => {
        const source = sources.get(boundary.inputMessageId);
        const ref = source?.message.lifecycle?.dispatchRefs?.find(
          (candidate) => candidate.targetId === lifecycle.targetId,
        );
        const outcome = getLifecycleAppendOutcome(ref, source?.message.lifecycle);
        const previous = boundaries[index - 1];
        return (
          lifecycle.inputMessageIds.includes(boundary.inputMessageId) &&
          source !== undefined &&
          source.position > responseIndex &&
          ref?.statusMessageId === response.id &&
          outcome !== 'not_accepted' &&
          outcome !== 'unknown' &&
          boundary.contentOffset <= content.length &&
          (!previous ||
            (boundary.contentOffset >= previous.contentOffset &&
              source.position >= (sources.get(previous.inputMessageId)?.position ?? Infinity))) &&
          verified.get(causalBoundaryKey(response, boundary)) === content.slice(0, boundary.contentOffset)
        );
      })
    )
      return;
    const first = boundaries[0];
    if (!first) return;
    originals.set(response.id, { start: 0, end: first.contentOffset + leading, inputMessageId: first.inputMessageId });
    boundaries.forEach((boundary, index) => {
      const slice = {
        response,
        inputMessageId: boundary.inputMessageId,
        start: boundary.contentOffset + leading,
        end: (boundaries[index + 1]?.contentOffset ?? content.length) + leading,
        nextInputMessageId: boundaries[index + 1]?.inputMessageId,
      };
      const existing = continuations.get(boundary.inputMessageId) ?? [];
      continuations.set(boundary.inputMessageId, [...existing, slice]);
    });
  });
  return { originals, continuations };
}
