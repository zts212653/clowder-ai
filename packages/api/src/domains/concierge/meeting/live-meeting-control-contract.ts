import type { CallbackPrincipal } from '@cat-cafe/shared';
import type { LiveContextScope } from '../live/host/live-controlled-context.js';
import type { F195CaptureObservation, F317MeetingGrant } from './f317-meeting-admission.js';

export type LiveMeetingPrincipal = Extract<CallbackPrincipal, { kind: 'invocation' }>;
export interface LiveMeetingRequest {
  scope: LiveContextScope;
  request?: { id: string; revision: string; text: string };
}
export interface MeetingAppSource {
  id: string;
  name: string;
}
export interface MeetingCapture extends F195CaptureObservation {
  chunks: number;
  asrState: string;
  inputs: readonly {
    id: string;
    source: 'app' | 'mic';
    label: string;
    state: string;
    appName?: string;
    signal?: { state: string; pcmBytes: number; peakAbs: number };
  }[];
}
export interface MeetingCaptureTarget {
  threadId: string;
  meetingId: string;
  startedAt: number;
}
export interface LiveMeetingAudioPort {
  sources(): Promise<MeetingAppSource[]>;
  status(): Promise<MeetingCapture | null>;
  start(input: { threadId: string; meetingId: string; source: MeetingAppSource }): Promise<MeetingCapture>;
  stop(target: MeetingCaptureTarget): Promise<void>;
}
export interface LiveMeetingControlPorts {
  authorize(principal: LiveMeetingPrincipal, requestId?: string, requireRequest?: boolean): Promise<LiveMeetingRequest>;
  audio: LiveMeetingAudioPort;
  ownerOfThread(threadId: string): Promise<string | null>;
}
export interface ControlledMeeting {
  scope: LiveContextScope;
  source?: MeetingAppSource;
  capture: MeetingCaptureTarget;
  grant?: F317MeetingGrant;
  ownsCapture?: boolean;
  stopAccepted?: boolean;
}
export function sameCapture(a: MeetingCaptureTarget, b: MeetingCaptureTarget): boolean {
  return a.threadId === b.threadId && a.meetingId === b.meetingId && a.startedAt === b.startedAt;
}
