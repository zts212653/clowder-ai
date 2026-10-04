import type { ChatMessage } from '@/stores/chat-types';
import { messageRendersNothing } from './message-render-visibility';

/** Your own message: a user message with no cat author (the same test `ChatMessage` uses to pick its user branch). */
export function isOwnHumanMessage(message: ChatMessage): boolean {
  return message.type === 'user' && !message.catId;
}

interface RunContext {
  /** The thread the rows are drawn in (a cross-thread source is judged against it). */
  currentThreadId?: string;
}

/**
 * F322 B segment 1 (human message). A run of your own messages shows its time once, under the last one (DESIGN.md「对话」).
 * The run is read from what is on screen: the next row that `ChatMessage` really draws decides. Another message of yours
 * extends the run; anything else that is drawn (a cat's reply, a system line) ends it; a row that draws nothing, whatever
 * kind it is (a recalled message, a body folded into a reply, an empty finished cat message, a cloud notice carried inside
 * the message it answers), is stepped over. A message that is not in the timeline we were handed is treated as the last:
 * showing its time twice is better than never showing it.
 */
export function isLastOfOwnRun(
  message: ChatMessage,
  timeline: readonly ChatMessage[],
  context: RunContext = {},
): boolean {
  const index = timeline.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return true;
  for (let next = index + 1; next < timeline.length; next++) {
    const candidate = timeline[next];
    if (messageRendersNothing(candidate, timeline, context)) continue;
    return !isOwnHumanMessage(candidate);
  }
  return true;
}
