// F152 Phase C: Distillation service for global lesson reflow (AC-C1/C3)
// Manages the candidate queue: nominate -> pending -> approve/reject -> materialize durable truth.
// Candidates persist in project store SQLite. Approved output materializes to .md files
// that GlobalIndexBuilder discovers and compiles into global_knowledge.sqlite.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export interface MaterializedTruth {
  id: string;
  anchor: string;
  kind: string;
  title: string;
  summary: string;
  keywords: string[];
  approvedBy: string;
  approvedAt: string;
  filePath: string;
}

export interface DistillationConfig {
  /** Directory where approved truths are materialized as .md files. */
  distilledRoot?: string;
}

/** F271 consumption interface: write approved truths without owning promotion/rejection. */
export interface DurableTruthPort {
  materialize(candidate: DistillationCandidate): Promise<MaterializedTruth>;
  listMaterialized(): MaterializedTruth[];
}

export class DistillationService implements DurableTruthPort {
  private readonly projectStore: SqliteEvidenceStore;
  private readonly globalStore: SqliteEvidenceStore;
  private readonly distilledRoot: string;

  constructor(projectStore: SqliteEvidenceStore, globalStore: SqliteEvidenceStore, config?: DistillationConfig) {
    this.projectStore = projectStore;
    this.globalStore = globalStore;
    this.distilledRoot = config?.distilledRoot ?? join(homedir(), '.cat-cafe', 'distilled-truths');
  }

  async initialize(): Promise<void> {
    // Ensure distilled root exists
    mkdirSync(this.distilledRoot, { recursive: true });

    // Create persistent candidate table in project store
    const db = this.projectStore.getDb();
    if (db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS distillation_candidates (
          id TEXT PRIMARY KEY,
          anchor TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'pending',
          evidence_json TEXT NOT NULL,
          project_path TEXT,
          nominated_at TEXT NOT NULL,
          reviewed_by TEXT,
          reviewed_at TEXT,
          materialized_path TEXT
        )
      `);
    }
  }

  async nominate(
    anchor: string,
    projectPath: string,
    options?: { personNames?: string[] },
  ): Promise<DistillationCandidate> {
    const db = this.projectStore.getDb();

    // Check for existing candidate: idempotent for pending/approved, re-entrant for rejected
    if (db) {
      const existing = db
        .prepare(
          'SELECT id, anchor, status, evidence_json, nominated_at, reviewed_by, reviewed_at FROM distillation_candidates WHERE anchor = ?',
        )
        .get(anchor) as CandidateRow | undefined;
      if (existing) {
        if (existing.status === 'rejected') {
          // Allow re-nomination after rejection: delete old row, fall through to create new
          db.prepare('DELETE FROM distillation_candidates WHERE id = ?').run(existing.id);
        } else {
          // pending or approved — return existing (idempotent)
          return rowToCandidate(existing);
        }
      }
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

    // Persist to SQLite
    if (db) {
      db.prepare(`
        INSERT INTO distillation_candidates (id, anchor, status, evidence_json, project_path, nominated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        candidate.id,
        candidate.anchor,
        candidate.status,
        JSON.stringify(candidate.evidence),
        projectPath,
        candidate.nominatedAt,
      );
    }

    return candidate;
  }

  async approve(candidateId: string, reviewerId: string): Promise<void> {
    const candidate = this.getCandidate(candidateId);
    if (!candidate) throw new Error(`Candidate "${candidateId}" not found`);

    candidate.status = 'approved';
    candidate.reviewedBy = reviewerId;
    candidate.reviewedAt = new Date().toISOString();

    // Materialize to durable truth file (survives rebuilds)
    const truth = await this.materialize(candidate);

    // Also upsert to globalStore for immediate searchability (before next rebuild)
    await this.globalStore.upsert([
      {
        anchor: truth.anchor,
        kind: truth.kind as import('./interfaces.js').EvidenceKind,
        status: 'active',
        title: truth.title,
        summary: truth.summary,
        keywords: truth.keywords,
        updatedAt: truth.approvedAt,
      },
    ]);

    // Update candidate record with materialized path
    const db = this.projectStore.getDb();
    if (db) {
      db.prepare(`
        UPDATE distillation_candidates
        SET status = 'approved', reviewed_by = ?, reviewed_at = ?, materialized_path = ?
        WHERE id = ?
      `).run(reviewerId, candidate.reviewedAt, truth.filePath, candidateId);
    }
  }

  async reject(candidateId: string, reviewerId: string): Promise<void> {
    const candidate = this.getCandidate(candidateId);
    if (!candidate) throw new Error(`Candidate "${candidateId}" not found`);

    const db = this.projectStore.getDb();
    if (db) {
      db.prepare(`
        UPDATE distillation_candidates
        SET status = 'rejected', reviewed_by = ?, reviewed_at = ?
        WHERE id = ?
      `).run(reviewerId, new Date().toISOString(), candidateId);
    }
  }

  async listPending(): Promise<DistillationCandidate[]> {
    const db = this.projectStore.getDb();
    if (!db) return [];

    const rows = db
      .prepare(
        'SELECT id, anchor, status, evidence_json, nominated_at, reviewed_by, reviewed_at FROM distillation_candidates WHERE status = ?',
      )
      .all('pending') as CandidateRow[];

    return rows.map(rowToCandidate);
  }

  /** F271 consumption interface: materialize an approved candidate as a durable .md truth file. */
  async materialize(candidate: DistillationCandidate): Promise<MaterializedTruth> {
    mkdirSync(this.distilledRoot, { recursive: true });

    const truth: MaterializedTruth = {
      id: candidate.id,
      anchor: `distilled:${candidate.id}`,
      kind: candidate.evidence.original.kind,
      title: candidate.evidence.sanitizedTitle,
      summary: candidate.evidence.sanitizedSummary,
      keywords: candidate.evidence.sanitizedKeywords,
      approvedBy: candidate.reviewedBy ?? 'unknown',
      approvedAt: candidate.reviewedAt ?? new Date().toISOString(),
      filePath: join(this.distilledRoot, `${candidate.id}.md`),
    };

    // Write durable truth file -- this is the source of truth that survives rebuilds.
    // GlobalIndexBuilder discovers and compiles these into global_knowledge.sqlite.
    const content = [
      '---',
      'type: distilled',
      `kind: ${truth.kind}`,
      `source_anchor: ${candidate.anchor}`,
      `approved_by: ${truth.approvedBy}`,
      `approved_at: ${truth.approvedAt}`,
      `candidate_id: ${candidate.id}`,
      truth.keywords.length > 0 ? `keywords: [${truth.keywords.join(', ')}]` : null,
      '---',
      '',
      `# ${truth.title}`,
      '',
      truth.summary,
      '',
    ]
      .filter((line): line is string => line != null)
      .join('\n');

    writeFileSync(truth.filePath, content, 'utf-8');
    return truth;
  }

  /** List all materialized truth files from the distilled root. */
  listMaterialized(): MaterializedTruth[] {
    if (!existsSync(this.distilledRoot)) return [];

    const truths: MaterializedTruth[] = [];
    for (const file of readdirSync(this.distilledRoot)) {
      if (!file.endsWith('.md')) continue;
      const filePath = join(this.distilledRoot, file);
      const content = readFileSync(filePath, 'utf-8');
      const truth = parseTruthFile(filePath, content);
      if (truth) truths.push(truth);
    }
    return truths;
  }

  private getCandidate(candidateId: string): DistillationCandidate | null {
    const db = this.projectStore.getDb();
    if (!db) return null;

    const row = db
      .prepare(
        'SELECT id, anchor, status, evidence_json, nominated_at, reviewed_by, reviewed_at FROM distillation_candidates WHERE id = ?',
      )
      .get(candidateId) as CandidateRow | undefined;

    return row ? rowToCandidate(row) : null;
  }
}

// -- Internal types and helpers -------------------------------------------------

interface CandidateRow {
  id: string;
  anchor: string;
  status: string;
  evidence_json: string;
  nominated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

function rowToCandidate(row: CandidateRow): DistillationCandidate {
  return {
    id: row.id,
    anchor: row.anchor,
    status: row.status as DistillationCandidate['status'],
    evidence: JSON.parse(row.evidence_json),
    nominatedAt: row.nominated_at,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
  };
}

function parseTruthFile(filePath: string, content: string): MaterializedTruth | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch?.[1]) return null;

  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split('\n')) {
    const kv = line.match(/^(\w[\w_]*):\s*(.+)$/);
    if (kv) fm[kv[1]!] = kv[2]!.trim();
  }

  if (fm.type !== 'distilled') return null;

  const candidateId = fm.candidate_id ?? filePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const bodyStart = content.indexOf('---', 4);
  const afterFm = bodyStart >= 0 ? content.slice(content.indexOf('\n', bodyStart) + 1).trim() : '';
  const lines = afterFm.split('\n');
  const titleLine = lines.findIndex((l) => l.startsWith('# '));
  const summaryLines =
    titleLine >= 0
      ? lines
          .slice(titleLine + 1)
          .join('\n')
          .trim()
      : afterFm;

  // Parse keywords from frontmatter
  let keywords: string[] = [];
  if (fm.keywords) {
    const kwMatch = fm.keywords.match(/\[(.+)]/);
    if (kwMatch) keywords = kwMatch[1].split(',').map((s) => s.trim());
  }

  return {
    id: candidateId,
    anchor: `distilled:${candidateId}`,
    kind: fm.kind ?? 'lesson',
    title: titleMatch?.[1] ?? candidateId,
    summary: summaryLines,
    keywords,
    approvedBy: fm.approved_by ?? 'unknown',
    approvedAt: fm.approved_at ?? '',
    filePath,
  };
}
