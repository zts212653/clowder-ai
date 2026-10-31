import type { F317MeetingSharePreview } from './f317-meeting-share-service.js';
import {
  type ControlledMeeting,
  type MeetingAppSource,
  type MeetingCapture,
  type MeetingCaptureTarget,
  sameCapture,
} from './live-meeting-control-contract.js';

export function singleAppCapture(capture: MeetingCapture | null, source: MeetingAppSource): capture is MeetingCapture {
  return Boolean(
    capture?.running &&
      capture.lifecycle === 'running' &&
      !capture.paused &&
      capture.startedAt > 0 &&
      capture.inputs.length === 1 &&
      capture.inputs[0]?.source === 'app' &&
      capture.inputs[0]?.state === 'running' &&
      capture.inputs[0]?.appName === source.id,
  );
}

export function meetingCaptureView(entry: ControlledMeeting, capture: MeetingCapture, sharing: boolean) {
  return {
    kind:
      capture.running && capture.lifecycle === 'running'
        ? 'running'
        : !capture.running && capture.lifecycle === 'stopped'
          ? 'stopped'
          : 'unconfirmed',
    sharing,
    paused: capture.paused,
    meetingId: capture.meetingId,
    captureThreadId: capture.threadId,
    source: entry.source,
    sourceLabel: entry.source?.name ?? entry.grant?.inputLabel,
    chunks: capture.chunks,
    asrState: capture.asrState,
    inputState: capture.inputs[0]?.state,
    signal: capture.inputs[0]?.signal,
    healthNote: 'PCM and processed chunks are observations, not proof of speech or successful ASR',
  };
}

export function previewMatchesCapture(
  preview: F317MeetingSharePreview,
  capture: MeetingCaptureTarget,
): preview is Extract<F317MeetingSharePreview, { kind: 'available' }> {
  return (
    preview.kind === 'available' &&
    sameCapture(
      {
        threadId: preview.intent.captureThreadId,
        meetingId: preview.intent.meetingId,
        startedAt: preview.intent.captureStartedAt,
      },
      capture,
    )
  );
}
