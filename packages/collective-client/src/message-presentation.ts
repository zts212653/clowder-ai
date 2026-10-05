import { eventDayLabel } from './channel-navigation.js';
import type { ChannelThread, CollectiveEventEnvelope } from './client-types.js';

/**
 * F322 B segment 1 (human message), shared-room half — whose message is this, as the viewer sees it?
 *
 * Identity contract (F290 owner): the viewer is the same-Service `snapshot.me.human.humanId`. A message is the viewer's
 * own only when the actor is a human, the viewer is known, and the two humanIds are equal. Never the display name (two
 * people can share one), never "no viewer given" (an unknown viewer owns nothing). Sender name and avatar always come from
 * the original event.
 */
export type AuthorPresentation = 'self' | 'other-human' | 'agent';

export function authorPresentation(event: CollectiveEventEnvelope, viewerHumanId?: string): AuthorPresentation {
  if (event.actor.kind !== 'human') return 'agent';
  const viewer = viewerHumanId?.trim();
  return viewer && viewer === event.actor.humanId ? 'self' : 'other-human';
}

/** Two consecutive events are one run of the viewer's own messages: both theirs, on the same day. */
function continuesSelfRun(a: CollectiveEventEnvelope, b: CollectiveEventEnvelope, viewerHumanId?: string): boolean {
  return (
    authorPresentation(a, viewerHumanId) === 'self' &&
    authorPresentation(b, viewerHumanId) === 'self' &&
    eventDayLabel(a.acceptedAt) === eventDayLabel(b.acceptedAt)
  );
}

/**
 * A run of the viewer's own messages shows its time once, under the last one (DESIGN.md「对话」). In the channel flow the
 * next thread decides: another message of the viewer's on the same day extends the run; anything else ends it.
 */
export function isLastOfSelfRun(threads: readonly ChannelThread[], index: number, viewerHumanId?: string): boolean {
  const current = threads[index];
  const next = threads[index + 1];
  if (!current || !next) return true;
  return !continuesSelfRun(current.root, next.root, viewerHumanId);
}

/** The same rule over the events of one topic (the root, then the replies in order). */
export function isLastOfSelfRunInTopic(
  events: readonly CollectiveEventEnvelope[],
  index: number,
  viewerHumanId?: string,
): boolean {
  const current = events[index];
  const next = events[index + 1];
  if (!current || !next) return true;
  return !continuesSelfRun(current, next, viewerHumanId);
}

/**
 * Which presentation the shared room draws when nobody has asked for one: the classic layout, the Café's own default
 * (`shell-presentation.ts`: no stored value means classic). The room follows the Café that opens it (DESIGN.md「对话」,
 * Opus 5.5's contract 2026-10-01). The choice reaches the room through the independent `collective:host-appearance` bridge
 * (the single-writer Release 3440; built in the companion PR, not here) - not through the work-context bridge, and with no
 * Work, membership or permission semantics. Until a host says anything, a room gets what the Café itself shows by default,
 * so merging this alone changes nothing an existing user sees.
 *
 * `?presentation=v2|classic` on the frame URL is a link and acceptance entry only, like the Café's `?shell=`; a standalone
 * room has no settings surface and gets no switch of its own. Components also take an explicit `presentation` (tests,
 * previews).
 */
export function defaultPresentation(
  search: string = typeof location === 'undefined' ? '' : location.search,
): 'v2' | 'classic' {
  return new URLSearchParams(search).get('presentation') === 'v2' ? 'v2' : 'classic';
}
