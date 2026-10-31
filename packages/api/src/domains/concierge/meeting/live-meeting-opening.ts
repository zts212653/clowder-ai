import { LiveMeetingAudioError } from './live-meeting-audio-error.js';
import { singleAppCapture } from './live-meeting-capture-binding.js';
import {
  type ControlledMeeting,
  type LiveMeetingControlPorts,
  type LiveMeetingRequest,
  type MeetingAppSource,
  type MeetingCapture,
  sameCapture,
} from './live-meeting-control-contract.js';
import { meetingStopConfirmed, stopMeetingCapture } from './live-meeting-stop.js';

/** One original capture transaction, retained until its uncertain result is reconciled. */
export interface MeetingOpening {
  current: LiveMeetingRequest;
  source: MeetingAppSource;
  meetingId: string;
  mode: 'start' | 'attach';
  capture: MeetingCapture | null;
  submitted: boolean;
  unconfirmed?: boolean;
  entry?: ControlledMeeting;
  previous?: ControlledMeeting;
}

export async function captureForOpening(
  tx: MeetingOpening,
  ports: LiveMeetingControlPorts,
  check: () => Promise<void>,
) {
  tx.capture = await ports.audio.status();
  if (tx.mode === 'start') {
    if (!tx.capture || tx.capture.running || tx.capture.lifecycle !== 'stopped')
      throw new Error('meeting_capture_unavailable_or_busy');
    await check();
    tx.submitted = true;
    tx.unconfirmed = true;
    tx.capture = await ports.audio.start({
      threadId: tx.current.scope.threadId,
      meetingId: tx.meetingId,
      source: tx.source,
    });
  }
  const capture = tx.capture;
  if (!singleAppCapture(capture, tx.source)) throw new Error('meeting_capture_binding_mismatch');
  if (tx.mode === 'start' && (capture.threadId !== tx.current.scope.threadId || capture.meetingId !== tx.meetingId))
    throw new Error('meeting_capture_binding_mismatch');
  if ((await ports.ownerOfThread(capture.threadId)) !== tx.current.scope.userId)
    throw new Error('meeting_capture_owner_mismatch');
  return {
    scope: tx.current.scope,
    source: tx.source,
    capture,
    ownsCapture: tx.mode === 'start' || Boolean(tx.previous?.ownsCapture && sameCapture(tx.previous.capture, capture)),
  };
}

export async function observeOpening(tx: MeetingOpening, ports: LiveMeetingControlPorts) {
  const observed = await ports.audio.status();
  if (
    !observed ||
    observed.meetingId !== tx.meetingId ||
    observed.threadId !== tx.current.scope.threadId ||
    observed.startedAt <= 0
  )
    return { observed: null, entry: undefined };
  if ((await ports.ownerOfThread(observed.threadId)) !== tx.current.scope.userId)
    throw new Error('meeting_capture_owner_mismatch');
  // Startup or failed-start finalization can retain coordinates before allocating inputs.
  const finalized = observed.lifecycle === 'stopped' && !observed.running;
  const unallocated = !observed.running && observed.lifecycle !== 'running' && observed.inputs.length === 0;
  const input = observed.inputs[0];
  if (
    !finalized &&
    !unallocated &&
    (observed.inputs.length !== 1 || input?.source !== 'app' || input.appName !== tx.source.id)
  )
    throw new Error('meeting_capture_binding_mismatch');
  // Only an authoritative materialized capture or completed transaction yields a target.
  if (!finalized && !(observed.lifecycle === 'running' && observed.running)) return { observed, entry: undefined };
  tx.capture = observed;
  tx.entry = { scope: tx.current.scope, source: tx.source, capture: observed, ownsCapture: true };
  return { observed, entry: tx.entry };
}

export async function rollbackOpening(
  tx: MeetingOpening,
  ports: LiveMeetingControlPorts,
  revoke: (entry?: ControlledMeeting) => Promise<boolean>,
  error: unknown,
) {
  const revoked = await revoke(tx.entry);
  if (tx.submitted) {
    if (!tx.entry && error instanceof LiveMeetingAudioError && error.statusCode !== 502 && error.statusCode !== 504) {
      tx.unconfirmed = false;
      if (!revoked) throw new Error('meeting_teardown_unconfirmed', { cause: error });
      return { active: undefined, lastStopped: undefined };
    }
    const { observed, entry } = await observeOpening(tx, ports);
    if (entry && observed) {
      const after = await stopMeetingCapture(ports.audio, entry);
      if (!meetingStopConfirmed(entry, after)) throw new Error('meeting_start_cleanup_unconfirmed', { cause: error });
      tx.unconfirmed = false;
      if (!revoked) throw new Error('meeting_teardown_unconfirmed', { cause: error });
      return { lastStopped: entry, active: undefined };
    }
    // A complete HTTP rejection is terminal; a transport timeout/abort is not.
    if (!(error instanceof LiveMeetingAudioError && error.statusCode !== 502 && error.statusCode !== 504))
      throw new Error('meeting_start_cleanup_unconfirmed', { cause: error });
  }
  tx.unconfirmed = false;
  if (!revoked) throw new Error('meeting_teardown_unconfirmed', { cause: error });
  return {
    active:
      tx.mode === 'attach' && tx.previous && tx.capture && sameCapture(tx.previous.capture, tx.capture)
        ? tx.previous
        : undefined,
    lastStopped: undefined,
  };
}
