import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { BallRecoveryBackend } from './ball-probe-recovery-backend.js';
import type { BallRecoveryCandidate, BallWakeAudit } from './ball-probe-recovery-state.js';

/** Exact admitted-envelope audit debts survive business owner/episode changes. This owner never dispatches work. */
export class BallProbeWakeAuditOwner {
  constructor(private readonly backend: BallRecoveryBackend) {}
  async recordWakeReceipt(
    candidate: BallRecoveryCandidate,
    input: { messageId: string; event: BallCustodyEvent },
  ): Promise<boolean> {
    const archiveKey = `admission:${candidate.scope}`;
    const recorded = await this.backend.readArchive(candidate.subjectKey, archiveKey);
    if (recorded) return JSON.parse(recorded).messageId === input.messageId;
    try {
      return await this.backend.mutate(candidate.subjectKey, ({ facts }) => {
        const receipt = {
          scope: candidate.scope,
          messageId: input.messageId,
          eventId: input.event.sourceEventId,
          at: input.event.at,
        };
        facts.wakeAudits ??= {};
        facts.wakeAudits[input.event.sourceEventId] ??= {
          key: input.event.sourceEventId,
          scope: candidate.scope,
          messageId: input.messageId,
          event: structuredClone(input.event),
          failures: 0,
          revision: 1,
          nextAt: input.event.at,
        };
        // An admitted old envelope still owes its original audit, but cannot settle a newer business scope.
        if (facts.probe?.scope === candidate.scope && !facts.rebuilding) {
          facts.wakeReceipt = receipt;
          facts.probe.disposition = 'settled';
          facts.probe.reasonCode = 'atomic_admission_confirmed';
        }
        return { result: true, requireArchiveAbsent: archiveKey, archive: { [archiveKey]: JSON.stringify(receipt) } };
      });
    } catch (error) {
      // The metadata CAS plus immutable receipt guard also covers a competing append+ACK+new-scope cycle.
      const winner = await this.backend.readArchive(candidate.subjectKey, archiveKey);
      if (winner) return JSON.parse(winner).messageId === input.messageId;
      throw error;
    }
  }

  async listWakeAudits(limit = 100, now = Date.now()): Promise<Array<{ subjectKey: string; audit: BallWakeAudit }>> {
    const selected: Array<{ subjectKey: string; audit: BallWakeAudit }> = [];
    for (const subjectKey of await this.backend.due('audit', now, limit)) {
      for (const audit of Object.values((await this.backend.readFacts(subjectKey))?.wakeAudits ?? {})) {
        if (!audit.disposition && audit.nextAt <= now) selected.push({ subjectKey, audit });
        if (selected.length >= limit) return selected;
      }
    }
    return selected;
  }
  async finishWakeAudit(subject: string, selected: BallWakeAudit, confirmed: boolean, now: number): Promise<void> {
    await this.backend.mutate(subject, ({ facts }) => {
      const current = facts.wakeAudits?.[selected.key];
      if (
        !current ||
        current.revision !== selected.revision ||
        current.scope !== selected.scope ||
        current.messageId !== selected.messageId
      )
        return { result: undefined };
      current.revision++;
      if (confirmed) {
        current.disposition = 'settled';
        if (facts.wakeReceipt?.scope === current.scope && facts.wakeReceipt.eventId === current.key)
          facts.wakeReceipt.eventRecorded = true;
      } else {
        current.failures++;
        current.nextAt = now + 60_000;
        if (current.failures >= 5) {
          current.disposition = 'needs_attention';
          facts.latestWakeAttention = current.key;
        }
      }
      if (!current.disposition) return { result: undefined };
      delete facts.wakeAudits?.[current.key];
      return { result: undefined, archive: { [`wake:${current.key}`]: JSON.stringify(current) } };
    });
  }
  async getWakeAudit(subject: string, key: string): Promise<BallWakeAudit | null> {
    const raw = await this.backend.readArchive(subject, `wake:${key}`);
    return raw ? (JSON.parse(raw) as BallWakeAudit) : null;
  }
  async recheckWakeAudit(subject: string, key: string): Promise<boolean> {
    const archived = await this.getWakeAudit(subject, key);
    if (!archived || archived.disposition !== 'needs_attention') return false;
    return this.backend.mutate(subject, ({ facts }) => {
      facts.wakeAudits ??= {};
      facts.wakeAudits[key] ??= {
        ...archived,
        failures: 0,
        nextAt: 0,
        revision: archived.revision + 1,
        disposition: undefined,
      };
      return { result: true };
    });
  }
}
