import type { LiveContextScope } from '../live/host/live-controlled-context.js';
import type { F317MeetingGrant } from './f317-meeting-admission.js';
import { type ControlledMeeting, sameCapture } from './live-meeting-control-contract.js';

/** Project the sole UI/Live share target into the authenticated scope, without granting transcript access. */
export function sharedMeetingBinding(
  scope: LiveContextScope,
  entry: ControlledMeeting | undefined,
  grant: F317MeetingGrant | null,
  stopped?: ControlledMeeting,
): ControlledMeeting | undefined {
  if (
    !grant ||
    grant.userId !== scope.userId ||
    grant.liveThreadId !== scope.threadId ||
    grant.catId !== scope.catId ||
    grant.callId !== scope.callId ||
    grant.generation !== scope.generation
  )
    return entry;
  const capture = {
    threadId: grant.captureThreadId,
    meetingId: grant.meetingId,
    startedAt: grant.captureStartedAt,
  };
  if (stopped && sameCapture(stopped.capture, capture)) return entry;
  if (entry && sameCapture(entry.capture, capture)) {
    entry.grant = grant;
    return entry;
  }
  // A revoked old share must never replace a newer record-only target.
  if (entry && grant.signal.aborted) return entry;
  return { scope, capture, grant, ownsCapture: false };
}
