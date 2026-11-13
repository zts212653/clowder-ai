import type { MemoryReadSnapshot } from './memory-read-execution.js';
import { MessageCandidateAudit, ownerCandidateAuditRequest } from './message-candidate-audit.js';
import { auditIdPattern, type MessageCandidateAuditRequest } from './message-candidate-audit-wire.js';
import type { CanonicalSearchCandidate } from './message-discovery-source.js';
import type { MessagePassageCandidate } from './message-passage-search-types.js';
import { privateMessageSearchTrace } from './message-search-trace.js';

/** Pseudonymous local operator evidence, not an ACL-isolated identity store or authority proof. */
export class MessageSearchCandidateDiagnostics {
  #request?: MessageCandidateAuditRequest;
  private audit?: MessageCandidateAudit;
  private readerExecutionId?: string;
  private published = false;
  private active = true;

  constructor(
    private readonly searchId: string,
    ownerId: string,
    private readonly sink?: (trace: Record<string, unknown>) => void,
  ) {
    if (sink) this.#request = ownerCandidateAuditRequest(searchId, ownerId);
    this.audit = MessageCandidateAudit.create(this.#request, 2000);
  }

  get request() {
    return this.#request;
  }

  worker(snapshot: MemoryReadSnapshot) {
    try {
      if (!this.active || snapshot.outcome !== 'fulfilled' || !auditIdPattern.test(snapshot.executionId)) return;
      // #6711 may discard an actual vector read and perform a lexical read. The latter owns ranks.
      if (this.audit?.adopt(snapshot.candidateAudit)) this.readerExecutionId = snapshot.executionId;
      else this.readerExecutionId = undefined;
    } catch {
      /* Observations never own result/cancellation semantics. */
    }
  }

  projection(candidate: MessagePassageCandidate, row: CanonicalSearchCandidate | null) {
    if (this.active && this.readerExecutionId) this.audit?.projection(candidate, row?.contentRevision);
  }

  window(rows: readonly CanonicalSearchCandidate[]) {
    if (this.active && this.readerExecutionId) this.audit?.window(rows.map((row) => row.candidate));
  }

  final(row: CanonicalSearchCandidate, fresh: CanonicalSearchCandidate | null) {
    if (this.active && this.readerExecutionId)
      this.audit?.final(row.candidate, fresh?.contentRevision, row.contentRevision);
  }

  publish() {
    if (!this.active || this.published) return;
    this.published = true;
    try {
      const safe = privateMessageSearchTrace({
        phase: 'candidate-audit',
        searchId: this.searchId,
        state: this.#request ? 'capture_incomplete' : 'identity_unavailable',
        readerExecutionId: this.readerExecutionId,
        candidateAudit: this.readerExecutionId ? this.audit?.snapshot() : undefined,
      });
      if (safe) this.sink?.(safe);
    } catch {
      /* A closed/throwing operator sink cannot replace a successful search. */
    }
  }

  close() {
    this.active = false;
    this.audit = undefined;
    this.#request = undefined;
  }
}
