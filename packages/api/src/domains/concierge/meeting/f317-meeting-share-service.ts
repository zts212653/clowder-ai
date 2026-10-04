import {
  canAdmitF317Meeting,
  type F195CaptureObservation,
  type F317LiveCallObservation,
  F317MeetingAdmission,
  type F317MeetingGrant,
  type F317MeetingShareIntent,
} from './f317-meeting-admission.js';

export interface F317MeetingSharePorts {
  observeCall(userId: string): Promise<F317LiveCallObservation | null>;
  observeCapture(): Promise<F195CaptureObservation | null>;
  ownerOfThread(threadId: string): Promise<string | null>;
  attach(grant: F317MeetingGrant, verify: () => Promise<boolean>): Promise<void>;
  detach(grant: F317MeetingGrant): Promise<void>;
  /** Exact grant is still attached to an open Host feed, independent of F195 capture status. */
  isAttached(grant: F317MeetingGrant): boolean;
}

export type F317MeetingSharePreview =
  | { kind: 'unavailable' }
  | { kind: 'available'; intent: F317MeetingShareIntent; catId: string; inputLabel: string; sharing: boolean };

export class F317MeetingShareService {
  private readonly admission = new F317MeetingAdmission();
  private attachedGrantId: string | null = null;
  private pendingAttach: { grantId: string; promise: Promise<void> } | null = null;

  constructor(private readonly ports: F317MeetingSharePorts) {}

  current(): F317MeetingGrant | null {
    return this.admission.current();
  }

  private async observe(actorUserId: string) {
    const [call, capture] = await Promise.all([this.ports.observeCall(actorUserId), this.ports.observeCapture()]);
    if (!call || !capture) return null;
    const sourceThreadOwnerUserId = await this.ports.ownerOfThread(capture.threadId);
    return { actorUserId, sourceThreadOwnerUserId: sourceThreadOwnerUserId ?? '', call, capture };
  }

  private async drop(grant = this.admission.current()): Promise<void> {
    if (!grant) return;
    if (this.admission.current()?.grantId === grant.grantId) this.admission.revoke();
    if (this.attachedGrantId === grant.grantId) this.attachedGrantId = null;
    await this.ports.detach(grant);
  }

  private async attached(grant: F317MeetingGrant): Promise<boolean> {
    if (this.attachedGrantId !== grant.grantId) return false;
    try {
      if (this.ports.isAttached(grant)) return true;
    } catch {
      // An uncertain Host attachment must not keep a share grant alive.
    }
    await this.drop(grant).catch(() => undefined);
    return false;
  }

  private async rejectLostAttachment(grant: F317MeetingGrant | null): Promise<void> {
    if (grant && this.attachedGrantId === grant.grantId && !(await this.attached(grant)))
      throw new Error('meeting_share_not_admitted');
  }

  async preview(actorUserId: string): Promise<F317MeetingSharePreview> {
    try {
      const observed = await this.observe(actorUserId);
      if (!observed) {
        await this.drop();
        return { kind: 'unavailable' };
      }
      const { call, capture } = observed;
      const intent = {
        callId: call.callId,
        generation: call.generation,
        captureThreadId: capture.threadId,
        meetingId: capture.meetingId,
        captureStartedAt: capture.startedAt,
        inputId: capture.inputs[0]?.id ?? '',
        inputLabel: capture.inputs[0]?.label ?? '',
      };
      if (!canAdmitF317Meeting({ ...observed, intent })) {
        await this.drop();
        return { kind: 'unavailable' };
      }
      const previous = this.admission.current();
      const admitted = this.admission.authorize(call, capture);
      if (previous && !admitted) await this.drop(previous);
      const sharing = Boolean(admitted && previous && (await this.attached(previous)));
      return { kind: 'available', intent, catId: call.catId, inputLabel: capture.inputs[0]?.label ?? '', sharing };
    } catch {
      await this.drop().catch(() => undefined);
      return { kind: 'unavailable' };
    }
  }

  async share(actorUserId: string, intent: F317MeetingShareIntent): Promise<F317MeetingGrant> {
    let observed: Awaited<ReturnType<F317MeetingShareService['observe']>>;
    try {
      observed = await this.observe(actorUserId);
    } catch {
      throw new Error('meeting_share_not_admitted');
    }
    if (!observed || !canAdmitF317Meeting({ ...observed, intent })) throw new Error('meeting_share_not_admitted');
    const previous = this.admission.current();
    await this.rejectLostAttachment(previous);
    const grant = this.admission.admit({ ...observed, intent });
    if (previous && previous.grantId !== grant.grantId) {
      this.attachedGrantId = null;
      await this.ports.detach(previous);
    }
    if (this.attachedGrantId === grant.grantId) return grant;
    if (this.pendingAttach?.grantId === grant.grantId) {
      await this.pendingAttach.promise;
      if (this.admission.current()?.grantId === grant.grantId && (await this.attached(grant))) return grant;
      throw new Error('meeting_share_not_admitted');
    }
    const promise = (async () => {
      await this.ports.attach(grant, () => this.verify(grant.grantId));
      if (!(await this.verify(grant.grantId))) throw new Error('meeting_share_not_admitted');
      if (!this.ports.isAttached(grant)) throw new Error('meeting_share_not_admitted');
      this.attachedGrantId = grant.grantId;
    })();
    this.pendingAttach = { grantId: grant.grantId, promise };
    try {
      await promise;
      if (!(await this.attached(grant))) throw new Error('meeting_share_not_admitted');
      return grant;
    } catch (error) {
      await this.drop(grant).catch(() => undefined);
      throw error;
    } finally {
      if (this.pendingAttach?.grantId === grant.grantId) this.pendingAttach = null;
    }
  }

  async verify(grantId: string): Promise<boolean> {
    const grant = this.admission.current();
    if (!grant || grant.grantId !== grantId || grant.signal.aborted) return false;
    if (this.attachedGrantId === grantId && !(await this.attached(grant))) return false;
    try {
      const observed = await this.observe(grant.userId);
      if (
        observed?.sourceThreadOwnerUserId === grant.userId &&
        this.admission.authorize(observed.call, observed.capture)
      )
        return true;
    } catch {
      // A status/read failure cannot keep a transcript grant alive.
    }
    if (this.admission.current()?.grantId === grant.grantId) this.admission.revoke();
    if (this.attachedGrantId === grant.grantId) this.attachedGrantId = null;
    void this.ports.detach(grant).catch(() => undefined);
    return false;
  }

  async revoke(actorUserId: string): Promise<void> {
    const grant = this.admission.current();
    if (grant && grant.userId !== actorUserId) throw new Error('meeting_share_not_owner');
    await this.drop();
  }
}
