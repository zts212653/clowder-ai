// F152 Phase C: Distillation service for global lesson reflow (AC-C3)
// Manages the candidate queue: nominate → pending → approve/reject → global store.

import { randomUUID } from 'node:crypto';
import { DeidentificationService, type DeidentifiedEvidence } from './deidentification-service.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';

const DISTILLABLE_KINDS = new Set(['lesson', 'decision']);

export interface DistillationCandidate {
  id: string;
  anchor: string;
  status: 'pending' | 'approved' | 'rejected';
  evidence: DeidentifiedEvidence;
  nominatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

export class DistillationService {
  private readonly projectStore: SqliteEvidenceStore;
  private readonly globalStore: SqliteEvidenceStore;
  private readonly candidates = new Map<string, DistillationCandidate>();
  private readonly anchorIndex = new Map<string, string>();

  constructor(projectStore: SqliteEvidenceStore, globalStore: SqliteEvidenceStore) {
    this.projectStore = projectStore;
    this.globalStore = globalStore;
  }

  async initialize(): Promise<void> {
    // In-memory queue for now. Future: persist to global store's SQLite.
  }

  async nominate(
    anchor: string,
    projectPath: string,
    options?: { personNames?: string[] },
  ): Promise<DistillationCandidate> {
    const existingId = this.anchorIndex.get(anchor);
    if (existingId) {
      const existing = this.candidates.get(existingId);
      if (existing) return existing;
    }

    const item = await this.projectStore.getByAnchor(anchor);
    if (!item) throw new Error(`Anchor "${anchor}" not found`);
    if (!item.generalizable) throw new Error(`Item "${anchor}" is not marked as generalizable`);
    if (!DISTILLABLE_KINDS.has(item.kind)) {
      throw new Error(`Item kind "${item.kind}" is not distillable (allowed: lesson, decision)`);
    }

    // P1 fix: create deidentifier per-request using the caller's projectPath
    const deidentifier = new DeidentificationService(projectPath, {
      personNames: options?.personNames,
    });
    const evidence = deidentifier.sanitize(item);
    const candidate: DistillationCandidate = {
      id: randomUUID(),
      anchor,
      status: 'pending',
      evidence,
      nominatedAt: new Date().toISOString(),
    };

    this.candidates.set(candidate.id, candidate);
    this.anchorIndex.set(anchor, candidate.id);
    return candidate;
  }

  async approve(candidateId: string, reviewerId: string): Promise<void> {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error(`Candidate "${candidateId}" not found`);

    candidate.status = 'approved';
    candidate.reviewedBy = reviewerId;
    candidate.reviewedAt = new Date().toISOString();

    await this.globalStore.upsert([
      {
        anchor: `distilled:${candidateId}`,
        kind: candidate.evidence.original.kind,
        status: 'active',
        title: candidate.evidence.sanitizedTitle,
        summary: candidate.evidence.sanitizedSummary,
        keywords: candidate.evidence.sanitizedKeywords,
        updatedAt: new Date().toISOString(),
      },
    ]);
  }

  async reject(candidateId: string, reviewerId: string): Promise<void> {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error(`Candidate "${candidateId}" not found`);

    candidate.status = 'rejected';
    candidate.reviewedBy = reviewerId;
    candidate.reviewedAt = new Date().toISOString();
  }

  async listPending(): Promise<DistillationCandidate[]> {
    return [...this.candidates.values()].filter((c) => c.status === 'pending');
  }
}
