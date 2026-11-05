import type { BallCustodyEvent, BallCustodyProjection } from '@cat-cafe/shared';
import { BallProbeWakeAuditOwner } from './BallProbeWakeAuditOwner.js';
import { BallProjectionCommitOwner } from './BallProjectionCommitOwner.js';
import type { BallRecoveryBackend } from './ball-probe-recovery-backend.js';
import {
  type BallProbeRecoveryFacts,
  type BallRecoveryCandidate,
  type BallRecoveryNotice,
  type BallRecoveryOutcome,
  type BallRecoveryOwner,
  type BallWakeAudit,
  finishBallProbeFacts,
  reconcileBallProbeFacts,
} from './ball-probe-recovery-state.js';

/** Ball-custody policy only; backend mutation retains its original EventLog subject facts and atomic projections. */
export class BallProbeRecoveryOwner {
  private readonly audits: BallProbeWakeAuditOwner;
  private readonly projectionCommits: BallProjectionCommitOwner;
  constructor(private readonly backend: BallRecoveryBackend) {
    this.audits = new BallProbeWakeAuditOwner(backend);
    this.projectionCommits = new BallProjectionCommitOwner(backend);
  }
  prepareConfirmedEvent(event: BallCustodyEvent) {
    return this.projectionCommits.prepare(event);
  }
  commitConfirmedEvent(event: BallCustodyEvent) {
    return this.projectionCommits.commit(event);
  }
  acknowledgeRebuiltEvent(event: BallCustodyEvent) {
    return this.projectionCommits.acknowledgeRebuild(event);
  }
  recordWakeReceipt(candidate: BallRecoveryCandidate, input: { messageId: string; event: BallCustodyEvent }) {
    return this.audits.recordWakeReceipt(candidate, input);
  }
  listWakeAudits(limit = 100, now = Date.now()) {
    return this.audits.listWakeAudits(limit, now);
  }
  finishWakeAudit(subject: string, selected: BallWakeAudit, confirmed: boolean, now: number) {
    return this.audits.finishWakeAudit(subject, selected, confirmed, now);
  }
  getWakeAudit(subject: string, key: string) {
    return this.audits.getWakeAudit(subject, key);
  }
  recheckWakeAudit(subject: string, key: string) {
    return this.audits.recheckWakeAudit(subject, key);
  }
  initializeRecovery(rebuild = false) {
    return this.backend.initialize(rebuild);
  }
  async getRecoveryNotice(subject: string, key: string): Promise<BallRecoveryNotice | null> {
    const raw = await this.backend.readArchive(subject, `notice:${key}`);
    return raw ? (JSON.parse(raw) as BallRecoveryNotice) : null;
  }
  getRecoveryFacts(subject: string) {
    return this.backend.readFacts(subject);
  }
  async save(projection: BallCustodyProjection): Promise<void> {
    await this.backend.mutate(projection.subjectKey, ({ facts }) => ({
      result: undefined,
      mode: 'write',
      projection,
      facts: reconcileBallProbeFacts(projection.subjectKey, projection, facts),
    }));
  }
  async delete(subject: string): Promise<void> {
    await this.backend.mutate(subject, ({ facts }) => {
      facts.rebuilding = true;
      return { result: undefined, mode: 'delete', projection: null };
    });
  }
  async finishRecoveryRebuild(subject: string): Promise<void> {
    await this.backend.mutate(subject, ({ projection, facts }) => ({
      result: undefined,
      facts: reconcileBallProbeFacts(subject, projection, facts, true),
    }));
  }
  private async candidates(subjects: string[], lane: 'probe' | 'idle'): Promise<BallRecoveryCandidate[]> {
    const selected: BallRecoveryCandidate[] = [];
    for (const subjectKey of subjects) {
      const facts = await this.backend.readFacts(subjectKey),
        work = facts?.[lane];
      if (work && !work.disposition && !facts?.rebuilding && !facts?.disposition)
        selected.push({
          subjectKey,
          lane,
          scope: work.scope,
          revision: work.revision,
          ...(work.intentAt === undefined ? {} : { intentAt: work.intentAt }),
        });
      else
        await this.backend.mutate(subjectKey, ({ facts, projection }) => ({
          result: undefined,
          facts: reconcileBallProbeFacts(subjectKey, projection, facts),
        }));
    }
    return selected;
  }
  async listProbeRecoveryCandidates(limit = 100, now = Date.now()) {
    return this.candidates(await this.backend.due('probe', now, limit), 'probe');
  }
  async listIdleRecoveryCandidates(limit: number, before: number, now = Date.now()) {
    const eligible = await this.backend.due('idle', before, limit);
    const retries = await this.backend.due('retry', now, limit - eligible.length);
    return this.candidates([...new Set([...eligible, ...retries])], 'idle');
  }
  async finishRecovery(
    candidate: BallRecoveryCandidate,
    outcome: BallRecoveryOutcome,
    now: number,
    owner?: BallRecoveryOwner,
    reasonCode?: string,
  ): Promise<boolean> {
    return this.backend.mutate(candidate.subjectKey, ({ facts }) => ({
      result: finishBallProbeFacts(facts, candidate, outcome, now, owner, reasonCode),
    }));
  }
  async claimIdleIntent(candidate: BallRecoveryCandidate, now: number): Promise<BallRecoveryCandidate | null> {
    return this.backend.mutate(candidate.subjectKey, ({ facts }) => {
      const work = facts.idle;
      if (!work || work.scope !== candidate.scope || work.revision !== candidate.revision || facts.rebuilding)
        return { result: null };
      if (work.intentAt === undefined) {
        work.intentAt = now;
        work.revision++;
      }
      return { result: { ...candidate, revision: work.revision, intentAt: work.intentAt } };
    });
  }
  async listRecoveryNotices(
    limit = 100,
    now = Date.now(),
  ): Promise<Array<{ subjectKey: string; notice: BallRecoveryNotice }>> {
    const notices: Array<{ subjectKey: string; notice: BallRecoveryNotice }> = [];
    for (const subjectKey of await this.backend.due('notice', now, limit)) {
      for (const notice of Object.values((await this.backend.readFacts(subjectKey))?.notices ?? {})) {
        if (notice.state === 'pending' && notice.nextAt <= now) notices.push({ subjectKey, notice });
        if (notices.length >= limit) return notices;
      }
    }
    return notices;
  }
  async finishRecoveryNotice(
    subject: string,
    selected: BallRecoveryNotice,
    disposition: 'delivered' | 'owner_unavailable' | 'failed',
    now: number,
  ): Promise<void> {
    await this.backend.mutate(subject, ({ facts }) => {
      const notice = facts.notices[selected.key];
      if (!notice || notice.state !== 'pending' || notice.failures !== selected.failures) return { result: undefined };
      if (disposition === 'failed') {
        notice.failures++;
        notice.nextAt = now + 60_000;
        if (notice.failures >= 5) notice.state = 'needs_attention';
      } else notice.state = disposition;
      if (notice.state === 'pending') return { result: undefined };
      if (notice.state === 'delivered' && facts[notice.lane]?.scope === notice.scope) {
        facts.noticeReceipts ??= {};
        facts.noticeReceipts[notice.lane] = notice.key;
      }
      delete facts.notices[notice.key];
      return { result: undefined, archive: { [`notice:${notice.key}`]: JSON.stringify(notice) } };
    });
  }
  async recheckRecovery(subject: string): Promise<BallProbeRecoveryFacts> {
    return this.backend.mutate(subject, ({ facts }) => {
      for (const lane of [facts.probe, facts.idle])
        if (lane?.disposition === 'needs_attention') {
          delete lane.disposition;
          delete lane.reasonCode;
          lane.failures = 0;
          lane.nextAt = 0;
          lane.revision++;
        }
      return { result: structuredClone(facts) };
    });
  }
}
