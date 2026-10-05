import { randomUUID } from 'node:crypto';
import { validBinding } from './f317-meeting-artifact.js';

/** One Live call may receive one explicitly admitted F195 capture at a time. */
export interface F317LiveCallObservation {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly callId: string;
  readonly generation: number;
  readonly state: 'preparing' | 'ready' | 'connecting' | 'talking' | 'closed' | 'failed';
}

export interface F195CaptureObservation {
  readonly running: boolean;
  readonly paused: boolean;
  readonly threadId: string;
  readonly meetingId: string;
  readonly startedAt: number;
  readonly inputs: readonly { id: string; source: 'app' | 'mic'; label: string; state: string }[];
}

/** Expected coordinates shown to the owner before the explicit share action. */
export interface F317MeetingShareIntent {
  readonly callId: string;
  readonly generation: number;
  readonly captureThreadId: string;
  readonly meetingId: string;
  readonly captureStartedAt: number;
  readonly inputId: string;
  readonly inputLabel: string;
}

export interface F317MeetingAdmissionInput {
  /** From authenticated, direct-local owner access; never from the request body. */
  readonly actorUserId: string;
  /** From the canonical ThreadStore read for the observed capture thread. */
  readonly sourceThreadOwnerUserId: string;
  readonly call: F317LiveCallObservation;
  readonly capture: F195CaptureObservation;
  readonly intent: F317MeetingShareIntent;
}

export interface F317MeetingGrant {
  readonly grantId: string;
  readonly userId: string;
  readonly callId: string;
  readonly liveThreadId: string;
  readonly catId: string;
  readonly generation: number;
  readonly captureThreadId: string;
  readonly meetingId: string;
  readonly captureStartedAt: number;
  readonly inputId: string;
  readonly inputLabel: string;
  readonly signal: AbortSignal;
}

function observedScope(call: F317LiveCallObservation, capture: F195CaptureObservation): boolean {
  const input = capture.inputs[0];
  return (
    validBinding({
      threadId: capture.threadId,
      meetingId: capture.meetingId,
      callId: call.callId,
      generation: call.generation,
    }) &&
    Boolean(call.userId && call.threadId && call.catId) &&
    call.state === 'talking' &&
    capture.running &&
    !capture.paused &&
    Number.isFinite(capture.startedAt) &&
    capture.startedAt > 0 &&
    capture.inputs.length === 1 &&
    input?.source === 'app' &&
    input.state === 'running' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(input.id) &&
    input.label.length > 0 &&
    input.label.length <= 256
  );
}

export function canAdmitF317Meeting(input: F317MeetingAdmissionInput): boolean {
  const { actorUserId, sourceThreadOwnerUserId, call, capture, intent } = input;
  return (
    observedScope(call, capture) &&
    Boolean(actorUserId) &&
    actorUserId === call.userId &&
    sourceThreadOwnerUserId === actorUserId &&
    intent.callId === call.callId &&
    intent.generation === call.generation &&
    intent.captureThreadId === capture.threadId &&
    intent.meetingId === capture.meetingId &&
    intent.captureStartedAt === capture.startedAt &&
    intent.inputId === capture.inputs[0]?.id &&
    intent.inputLabel === capture.inputs[0]?.label
  );
}

function sameScope(grant: F317MeetingGrant, call: F317LiveCallObservation, capture: F195CaptureObservation): boolean {
  const input = capture.inputs[0];
  return (
    observedScope(call, capture) &&
    grant.userId === call.userId &&
    grant.callId === call.callId &&
    grant.liveThreadId === call.threadId &&
    grant.catId === call.catId &&
    grant.generation === call.generation &&
    grant.captureThreadId === capture.threadId &&
    grant.meetingId === capture.meetingId &&
    grant.captureStartedAt === capture.startedAt &&
    grant.inputId === input?.id &&
    grant.inputLabel === input.label
  );
}

export class F317MeetingAdmission {
  private grant: F317MeetingGrant | null = null;
  private controller: AbortController | null = null;

  current(): F317MeetingGrant | null {
    return this.grant;
  }

  admit(input: F317MeetingAdmissionInput): F317MeetingGrant {
    if (!canAdmitF317Meeting(input)) throw new Error('meeting_share_not_admitted');
    const { actorUserId, call, capture } = input;
    if (this.grant && sameScope(this.grant, call, capture)) return this.grant;
    this.revoke();
    const controller = new AbortController();
    const source = capture.inputs[0];
    if (!source) throw new Error('meeting_share_not_admitted');
    this.controller = controller;
    this.grant = {
      grantId: randomUUID(),
      userId: actorUserId,
      callId: call.callId,
      liveThreadId: call.threadId,
      catId: call.catId,
      generation: call.generation,
      captureThreadId: capture.threadId,
      meetingId: capture.meetingId,
      captureStartedAt: capture.startedAt,
      inputId: source.id,
      inputLabel: source.label,
      signal: controller.signal,
    };
    return this.grant;
  }

  authorize(call: F317LiveCallObservation, capture: F195CaptureObservation): boolean {
    if (!this.grant) return false;
    if (sameScope(this.grant, call, capture) && !this.grant.signal.aborted) return true;
    this.revoke();
    return false;
  }

  revoke(): void {
    this.controller?.abort();
    this.controller = null;
    this.grant = null;
  }
}
