import {
  type ControlledMeeting,
  type LiveMeetingAudioPort,
  type MeetingCapture,
  sameCapture,
} from './live-meeting-control-contract.js';

export function meetingStopConfirmed(target: ControlledMeeting, observed: MeetingCapture | null): boolean {
  return Boolean(
    observed &&
      ((observed.lifecycle === 'stopped' && !observed.running) ||
        (observed.lifecycle === 'running' && !sameCapture(target.capture, observed))),
  );
}

/** A 2xx stop releases the controller lease. Retry observes its result instead of reusing that lease. */
export async function stopMeetingCapture(audio: LiveMeetingAudioPort, target: ControlledMeeting) {
  const before = await audio.status();
  if (meetingStopConfirmed(target, before) || before?.lifecycle === 'finalizing' || target.stopAccepted) return before;
  await audio.stop(target.capture);
  target.stopAccepted = true;
  return await audio.status();
}
