import { randomUUID } from 'node:crypto';
import { whileNotAborted } from '../live/host/live-controlled-context.js';
import { sameScope } from '../live/host/page-action/live-page-action-authority-contract.js';
import type { F317MeetingShareService } from './f317-meeting-share-service.js';
import { meetingCaptureView, previewMatchesCapture } from './live-meeting-capture-binding.js';
import {
  type ControlledMeeting,
  type LiveMeetingControlPorts,
  type LiveMeetingPrincipal,
  type LiveMeetingRequest,
  type MeetingAppSource,
  type MeetingCapture,
  sameCapture,
} from './live-meeting-control-contract.js';
import { captureForOpening, type MeetingOpening, observeOpening, rollbackOpening } from './live-meeting-opening.js';
import { isMeetingStopRequest, meetingRequestSource, requestSharesTranscript } from './live-meeting-request.js';
import { LiveMeetingRequestHistory } from './live-meeting-request-history.js';
import { sharedMeetingBinding } from './live-meeting-shared-binding.js';
import { meetingStopConfirmed, stopMeetingCapture } from './live-meeting-stop.js';

type StartInput = { requestMessageId?: string; sourceId: string; mode: 'start' | 'attach' };

export class LiveMeetingControl {
  private active?: ControlledMeeting;
  private lastStopped?: ControlledMeeting;
  private opening?: Promise<unknown>;
  private transaction?: MeetingOpening;
  private openingScope?: ControlledMeeting['scope'];
  private epoch = 0;
  private readonly consumed = new LiveMeetingRequestHistory();
  private stopping = false;
  private stoppingDone?: Promise<void>;
  private closed = false;
  constructor(
    private readonly ports: LiveMeetingControlPorts,
    private readonly share: F317MeetingShareService,
  ) {}

  async sources(principal: LiveMeetingPrincipal) {
    const current = await this.ports.authorize(principal);
    const apps = await this.ports.audio.sources();
    const next = await this.ports.authorize(principal);
    if (!sameScope(current.scope, next.scope)) throw new Error('meeting_call_changed');
    return { kind: 'sources', apps, scope: 'single_app_no_microphone' };
  }

  async start(principal: LiveMeetingPrincipal, input: StartInput) {
    if (this.closed || this.stopping || this.opening || this.transaction?.unconfirmed)
      throw new Error('meeting_control_busy');
    const pending = this.open(principal, input, this.epoch);
    this.opening = pending;
    try {
      return await pending;
    } finally {
      if (this.opening === pending) {
        this.opening = undefined;
        this.openingScope = undefined;
        if (!this.transaction?.unconfirmed) this.transaction = undefined;
        else if (this.transaction.entry) this.active = this.transaction.entry;
      }
    }
  }

  private async open(principal: LiveMeetingPrincipal, input: StartInput, epoch: number) {
    const current = await this.ports.authorize(principal, input.requestMessageId, true);
    this.openingScope = current.scope;
    const request = current.request;
    if (!request) throw new Error('meeting_request_unavailable');
    const requestId = request.id;
    const sources = await this.ports.audio.sources();
    const source = meetingRequestSource(request.text, input.mode, sources);
    if (!source || source.id !== input.sourceId)
      return { kind: 'needs_source', reason: 'Explicit unique App source and operation required' };
    if (this.consumed.has(current.scope, request.id)) return await this.status(principal);
    this.alignSharedCapture(current.scope);
    const observed = await this.ports.audio.status();
    if (this.active && observed?.lifecycle === 'stopped' && !observed.running) {
      if (!(await this.revokeConfirmed(this.active))) throw new Error('meeting_teardown_unconfirmed');
      this.active = undefined;
    }
    if (this.active && (input.mode !== 'attach' || !sameScope(this.active.scope, current.scope)))
      throw new Error('meeting_already_bound');
    const tx: MeetingOpening = {
      current,
      source,
      meetingId: `mtg-${randomUUID().replaceAll('-', '')}`,
      mode: input.mode,
      capture: null,
      submitted: false,
      previous: this.active,
    };
    this.transaction = tx;
    try {
      await this.check(principal, requestId, current, epoch);
      tx.entry = await captureForOpening(tx, this.ports, async () => {
        await this.check(principal, requestId, current, epoch);
        this.consumed.remember(current.scope, requestId);
      });
      this.active = tx.entry;
      await this.check(principal, requestId, current, epoch);
      if (requestSharesTranscript(request.text, input.mode)) {
        const preview = await this.share.preview(current.scope.userId);
        if (!previewMatchesCapture(preview, tx.entry.capture)) throw new Error('meeting_capture_binding_mismatch');
        tx.entry.grant = await this.share.share(current.scope.userId, preview.intent);
      }
      await this.check(principal, requestId, current, epoch);
      tx.unconfirmed = false;
      this.consumed.remember(current.scope, requestId);
      return await this.status(principal);
    } catch (error) {
      const restored = await rollbackOpening(tx, this.ports, (entry) => this.revokeConfirmed(entry), error);
      if (this.active === tx.entry) this.active = restored.active;
      if (restored.lastStopped) this.lastStopped = restored.lastStopped;
      throw error;
    }
  }

  private async revoke(entry?: ControlledMeeting, ownerUserId?: string): Promise<void> {
    const grant = this.share.current();
    if (!entry || (!grant && ownerUserId)) {
      if (ownerUserId) await this.share.revoke(ownerUserId);
      return;
    }
    if (
      entry &&
      grant?.callId === entry.scope.callId &&
      grant.generation === entry.scope.generation &&
      grant.captureThreadId === entry.capture.threadId &&
      grant.meetingId === entry.capture.meetingId &&
      grant.captureStartedAt === entry.capture.startedAt
    )
      await this.share.revoke(entry.scope.userId);
  }

  private async revokeConfirmed(entry?: ControlledMeeting, ownerUserId?: string): Promise<boolean> {
    try {
      await whileNotAborted(AbortSignal.timeout(2_000), this.revoke(entry, ownerUserId));
      return true;
    } catch {
      return false;
    }
  }

  private async check(
    principal: LiveMeetingPrincipal,
    id: string,
    before: Awaited<ReturnType<LiveMeetingControlPorts['authorize']>>,
    epoch: number,
  ) {
    const now = await this.ports.authorize(principal, id);
    if (
      this.closed ||
      epoch !== this.epoch ||
      !sameScope(before.scope, now.scope) ||
      before.request?.revision !== now.request?.revision
    )
      throw new Error('meeting_request_changed');
  }

  async status(principal: LiveMeetingPrincipal) {
    const current = await this.ports.authorize(principal);
    this.alignSharedCapture(current.scope);
    const pending = await this.reconcileOpening(current.scope);
    const nextScope = await this.ports.authorize(principal);
    if (!sameScope(current.scope, nextScope.scope)) throw new Error('meeting_call_changed');
    if (pending) return pending;
    const entry = this.active;
    if (!entry) return { kind: 'idle', sharing: false };
    if (!sameScope(entry.scope, current.scope)) throw new Error('meeting_call_changed');
    const capture = await this.ports.audio.status();
    const preview = await this.share.preview(current.scope.userId);
    const sharing = Boolean(previewMatchesCapture(preview, entry.capture) && preview.sharing);
    await this.assertCaptureOwner(entry);
    const next = await this.ports.authorize(principal);
    if (!sameScope(entry.scope, next.scope)) throw new Error('meeting_call_changed');
    if (!capture || !sameCapture(entry.capture, capture))
      return { kind: 'unconfirmed', sharing: false, reason: 'Capture changed or status unavailable' };
    return meetingCaptureView(entry, capture, sharing);
  }

  async stop(principal: LiveMeetingPrincipal, requestMessageId?: string, meetingId?: string) {
    const current = await this.ports.authorize(principal, requestMessageId, true);
    if (!current.request || !isMeetingStopRequest(current.request.text))
      throw new Error('meeting_stop_request_required');
    this.alignSharedCapture(current.scope);
    const entry = this.active;
    this.assertStopTarget(current.scope, meetingId);
    if (this.stopping) throw new Error('meeting_control_busy');
    this.stopping = true;
    let finished!: () => void;
    this.stoppingDone = new Promise<void>((resolve) => {
      finished = resolve;
    });
    this.epoch++;
    try {
      // Grant abort is synchronous; Host detach cannot delay the actual capture stop.
      const revocation = this.revokeConfirmed(entry, current.scope.userId);
      await this.opening?.catch(() => undefined);
      const pending = await this.reconcileOpening(current.scope);
      const target = this.active;
      if (!target && pending) return pending;
      if (!target) return this.emptyStop(current.scope);
      this.assertStopTarget(current.scope, meetingId);
      const targetRevocation = target === entry ? revocation : this.revokeConfirmed(target);
      return await this.finishStop(target, Promise.all([revocation, targetRevocation]));
    } finally {
      this.stopping = false;
      finished();
      this.stoppingDone = undefined;
    }
  }

  private assertStopTarget(scope: ControlledMeeting['scope'], meetingId?: string) {
    const tx = this.transaction;
    if (tx && !sameScope(tx.current.scope, scope)) throw new Error('meeting_stop_target_mismatch');
    const remembered = this.active ?? this.lastStopped;
    const expectedId = tx?.meetingId ?? (this.opening ? undefined : remembered?.capture.meetingId);
    if (
      meetingId !== undefined &&
      (meetingId !== expectedId || (!tx && remembered && !sameScope(remembered.scope, scope)))
    )
      throw new Error('meeting_stop_target_mismatch');
    if (this.active && !sameScope(this.active.scope, scope)) throw new Error('meeting_stop_target_mismatch');
    if (this.openingScope && !sameScope(this.openingScope, scope)) throw new Error('meeting_stop_target_mismatch');
  }

  private emptyStop(scope: ControlledMeeting['scope']) {
    return this.lastStopped && sameScope(this.lastStopped.scope, scope)
      ? { kind: 'stopped', sharing: false, meetingId: this.lastStopped.capture.meetingId }
      : { kind: 'idle', sharing: false };
  }

  private async finishStop(target: ControlledMeeting, revocation: Promise<boolean[]>) {
    await this.assertCaptureOwner(target);
    const observed = await stopMeetingCapture(this.ports.audio, target);
    if (!meetingStopConfirmed(target, observed))
      return { kind: 'unconfirmed', sharing: false, reason: 'Stop not confirmed' };
    this.active = undefined;
    this.lastStopped = target;
    if (this.transaction?.meetingId === target.capture.meetingId) this.transaction = undefined;
    if ((await revocation).some((confirmed) => !confirmed))
      return {
        kind: 'unconfirmed',
        sharing: false,
        meetingId: target.capture.meetingId,
        reason: 'Capture stopped; Host teardown unconfirmed',
      };
    return { kind: 'stopped', sharing: false, meetingId: target.capture.meetingId };
  }

  private async assertCaptureOwner(entry: ControlledMeeting) {
    if ((await this.ports.ownerOfThread(entry.capture.threadId)) !== entry.scope.userId)
      throw new Error('meeting_capture_owner_mismatch');
  }

  private async reconcileOpening(scope: ControlledMeeting['scope']) {
    const tx = this.transaction;
    if (this.opening && (!tx || tx.unconfirmed))
      return { kind: 'unconfirmed', sharing: false, meetingId: tx?.meetingId, reason: 'Opening has not completed' };
    if (!tx?.unconfirmed) return undefined;
    if (!sameScope(tx.current.scope, scope)) throw new Error('meeting_call_changed');
    const { observed, entry } = await observeOpening(tx, this.ports);
    if (entry) this.active = entry;
    if (entry && observed?.lifecycle === 'stopped' && !observed.running) {
      this.active = undefined;
      this.lastStopped = entry;
      this.transaction = undefined;
      return { kind: 'stopped', sharing: false, meetingId: tx.meetingId };
    }
    return {
      kind: 'unconfirmed',
      sharing: false,
      meetingId: tx.meetingId,
      reason: 'Original opening outcome or cleanup is not confirmed',
    };
  }

  private alignSharedCapture(scope: ControlledMeeting['scope']) {
    this.active = sharedMeetingBinding(
      scope,
      this.active,
      this.share.current() ?? this.share.lastShared(),
      this.lastStopped,
    );
  }

  async close(options: { controllerWillStop?: boolean } = {}) {
    this.closed = true;
    this.epoch++;
    const revocation = this.revokeConfirmed(this.active);
    await this.stoppingDone;
    await this.opening?.catch(() => undefined);
    this.consumed.clear();
    const tx = this.transaction;
    if (tx?.unconfirmed) await this.reconcileOpening(tx.current.scope);
    const entry = this.active;
    if (this.transaction?.unconfirmed && !entry && !options.controllerWillStop)
      throw new Error('meeting_teardown_unconfirmed');
    if (entry) {
      const targetRevocation = this.revokeConfirmed(entry);
      if (
        !options.controllerWillStop &&
        !meetingStopConfirmed(entry, await stopMeetingCapture(this.ports.audio, entry))
      )
        throw new Error('meeting_teardown_unconfirmed');
      this.active = undefined;
      if (!(await targetRevocation)) throw new Error('meeting_teardown_unconfirmed');
    }
    if (!(await revocation)) throw new Error('meeting_teardown_unconfirmed');
  }

  async releaseCall(callId: string) {
    this.consumed.release(callId);
    if (
      this.active?.scope.callId !== callId &&
      (this.transaction?.current.scope.callId ?? this.openingScope?.callId) !== callId
    )
      return;
    await this.stoppingDone;
    if (
      this.active?.scope.callId !== callId &&
      (this.transaction?.current.scope.callId ?? this.openingScope?.callId) !== callId
    )
      return;
    this.epoch++;
    const revocation = this.revokeConfirmed(this.active);
    await this.opening?.catch(() => undefined);
    if (this.transaction?.unconfirmed) await this.reconcileOpening(this.transaction.current.scope);
    const entry = this.active;
    if (!entry && this.transaction?.unconfirmed) throw new Error('meeting_teardown_unconfirmed');
    if (entry?.scope.callId !== callId) return;
    const targetRevocation = this.revokeConfirmed(entry);
    if (entry.ownsCapture) {
      await this.assertCaptureOwner(entry);
      if (!meetingStopConfirmed(entry, await stopMeetingCapture(this.ports.audio, entry)))
        throw new Error('meeting_teardown_unconfirmed');
    }
    if (this.active === entry) this.active = undefined;
    if (this.transaction?.meetingId === entry.capture.meetingId) this.transaction = undefined;
    if (!(await revocation) || !(await targetRevocation)) throw new Error('meeting_teardown_unconfirmed');
  }
}
