import type { FreshnessReadableMessage } from '../../cats/services/freshness/checkFreshnessForPostMessage.js';
import type { F317LiveCallObservation, F317MeetingGrant } from '../meeting/f317-meeting-admission.js';
import type { LiveMeetingDependencies } from './host/live-meeting-host.js';
import { type LiveCarrierOperationLease, LiveCarrierUnavailableError } from './LiveCarrierOperationGate.js';
import type { LiveCompanionCall, LiveCompanionCallOptions } from './LiveCompanionCall.js';

export class LiveCallAlreadyActiveError extends Error {
  constructor() {
    super('Live call already active');
    this.name = 'LiveCallAlreadyActiveError';
  }
}

/** Ephemeral surface handles only. Execution and messages remain in their ordinary Host stores. */
export class LiveCompanionSessions {
  private readonly calls = new Map<string, { userId: string; call: LiveCompanionCall; claimed: boolean }>();
  private readonly preparing = new Set<string>();
  private readonly changingPreferences = new Set<string>();
  // Bounded surface diagnostics only: these snapshots hold no executable call or credentials.
  private readonly terminal = new Map<string, { userId: string; status: ReturnType<LiveCompanionCall['status']> }>();

  constructor(private readonly meeting?: LiveMeetingDependencies) {}

  async observeCall(userId: string): Promise<F317LiveCallObservation | null> {
    const entries = [...this.calls.values()].filter((entry) => entry.claimed && entry.userId === userId);
    const entry = entries[0];
    if (entries.length !== 1 || !entry || !(await entry.call.hasCurrentCompanion())) return null;
    return entry.call.boundaryContexts.observeCall();
  }

  async attach(grant: F317MeetingGrant, verify: () => Promise<boolean>): Promise<void> {
    const entry = this.calls.get(grant.callId);
    if (!this.meeting || !entry?.claimed || entry.userId !== grant.userId || !(await entry.call.hasCurrentCompanion()))
      throw new Error('meeting_share_not_admitted');
    await entry.call.boundaryContexts.attachMeeting(grant, verify, this.meeting);
  }

  async detach(grant: F317MeetingGrant): Promise<void> {
    const entry = this.calls.get(grant.callId);
    if (entry?.userId === grant.userId) entry.call.boundaryContexts.detachMeeting(grant);
  }

  isAttached(grant: F317MeetingGrant): boolean {
    const entry = this.calls.get(grant.callId);
    return Boolean(
      entry?.claimed && entry.userId === grant.userId && entry.call.boundaryContexts.isMeetingAttached(grant),
    );
  }

  async prepare(options: LiveCompanionCallOptions): Promise<LiveCompanionCall> {
    const userId = options.binding.userId;
    if (
      this.changingPreferences.has(userId) ||
      this.preparing.has(userId) ||
      [...this.calls.values()].some((entry) => entry.userId === userId)
    )
      throw new LiveCallAlreadyActiveError();
    this.preparing.add(userId);
    try {
      const { LiveCompanionCall: Call } = await import('./LiveCompanionCall.js');
      const call = await Call.create(options);
      const entry = { userId, call, claimed: false };
      this.calls.set(call.id, entry);
      this.terminal.delete(call.id);
      void call.finished
        .finally(() => {
          if (this.calls.get(call.id) !== entry) return;
          this.calls.delete(call.id);
          const status = call.status();
          if (!status.failureCode) return;
          this.terminal.set(call.id, { userId, status });
          if (this.terminal.size > 32) this.terminal.delete(this.terminal.keys().next().value!);
        })
        .catch(() => {});
      return call;
    } finally {
      this.preparing.delete(userId);
    }
  }

  get(id: string, userId: string): LiveCompanionCall | undefined {
    const entry = this.calls.get(id);
    return entry?.userId === userId ? entry.call : undefined;
  }

  readStatus(id: string, userId: string): ReturnType<LiveCompanionCall['status']> | undefined {
    const active = this.get(id, userId);
    if (active) return active.status();
    const retired = this.terminal.get(id);
    return retired?.userId === userId ? retired.status : undefined;
  }

  /** Fence new admission while the owner ends media and commits a permission choice. */
  isChangingPreferences(userId: string): boolean {
    return this.changingPreferences.has(userId);
  }

  async withOwnerPreferenceChange<T>(
    userId: string,
    save: () => Promise<T>,
    revokeMedia?: () => Promise<void | false>,
    onStopped?: () => void,
  ): Promise<T> {
    if (this.changingPreferences.has(userId) || this.preparing.has(userId)) throw new LiveCallAlreadyActiveError();
    this.changingPreferences.add(userId);
    try {
      if ((await revokeMedia?.()) === false) return await save();
      const owned = [...this.calls.values()].filter((entry) => entry.userId === userId);
      await Promise.all(owned.map(({ call }) => call.stop()));
      if (owned.some(({ call }) => call.status().state !== 'closed')) throw new Error('Live teardown unconfirmed');
      if (owned.length > 0) onStopped?.();
      return await save();
    } finally {
      this.changingPreferences.delete(userId);
    }
  }

  claim(id: string, userId: string, threadId: string, targetCats: readonly string[]): LiveCompanionCall {
    const entry = this.calls.get(id);
    const scope = entry?.call.status();
    if (
      !entry ||
      entry.claimed ||
      entry.userId !== userId ||
      scope?.threadId !== threadId ||
      targetCats.length !== 1 ||
      targetCats[0] !== scope.catId
    )
      throw new Error('Live admission mismatch');
    entry.claimed = true;
    return entry.call;
  }

  async close(): Promise<void> {
    await Promise.all([...this.calls.values()].map(({ call }) => call.stop()));
  }
  signalInbox(userId: string, threadId: string): void {
    for (const entry of this.calls.values())
      if (entry.userId === userId && entry.call.status().threadId === threadId) entry.call.signalInbox();
  }
  async isActiveCarrier(query: { invocationId: string; catId: string; threadId: string }): Promise<boolean> {
    return [...this.calls.values()].some((entry) => entry.claimed && entry.call.isActiveCarrier(query));
  }
  async withCarrierOperation<T>(
    query: { invocationId: string; catId: string; threadId: string },
    operation: (lease: LiveCarrierOperationLease) => Promise<T>,
  ): Promise<T> {
    const entry = [...this.calls.values()].find((item) => item.claimed && item.call.isActiveCarrier(query));
    if (!entry) throw new LiveCarrierUnavailableError();
    return entry.call.withCarrierOperation(query, operation);
  }
  exposureReason(
    query: { invocationId: string; catId: string; threadId: string },
    message: FreshnessReadableMessage,
  ): 'same_live_call_exposure' | null {
    const entry = [...this.calls.values()].find((item) => item.claimed && item.call.isActiveCarrier(query));
    return entry?.call.exposureReason(message) ?? null;
  }
}
