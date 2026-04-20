import crypto from 'node:crypto';
import type { ContentScanFinding, SkillFingerprint, SkillSecurityEntry } from '@cat-cafe/shared';

interface RegisterInput {
  source: string;
  version: string;
  content: string;
}

interface FingerprintVerification {
  valid: boolean;
  expected: string;
  actual: string;
}

function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function buildFingerprint(input: RegisterInput): SkillFingerprint {
  return {
    source: input.source,
    version: input.version,
    contentHash: computeHash(input.content),
    recordedAt: new Date().toISOString(),
  };
}

export class SkillSecurityStore {
  private entries: Map<string, SkillSecurityEntry>;

  private constructor(entries?: Map<string, SkillSecurityEntry>) {
    this.entries = entries ?? new Map();
  }

  static createInMemory(): SkillSecurityStore {
    return new SkillSecurityStore();
  }

  register(skillId: string, input: RegisterInput): SkillSecurityEntry {
    const entry: SkillSecurityEntry = {
      skillId,
      status: 'pending_review',
      fingerprint: buildFingerprint(input),
      scanFindings: [],
    };
    this.entries.set(skillId, entry);
    return entry;
  }

  get(skillId: string): SkillSecurityEntry | undefined {
    return this.entries.get(skillId);
  }

  list(): SkillSecurityEntry[] {
    return [...this.entries.values()];
  }

  approve(skillId: string, approver: string): SkillSecurityEntry {
    const entry = this.requireEntry(skillId);
    this.assertNotTerminal(entry);
    const updated: SkillSecurityEntry = {
      ...entry,
      status: 'approved',
      approvedBy: approver,
      approvedAt: new Date().toISOString(),
    };
    this.entries.set(skillId, updated);
    return updated;
  }

  quarantine(skillId: string, findings: ContentScanFinding[]): SkillSecurityEntry {
    const entry = this.requireEntry(skillId);
    this.assertNotTerminal(entry);
    const updated: SkillSecurityEntry = {
      ...entry,
      status: 'quarantined',
      scanFindings: findings,
    };
    this.entries.set(skillId, updated);
    return updated;
  }

  revoke(skillId: string, revoker: string): SkillSecurityEntry {
    const entry = this.requireEntry(skillId);
    const updated: SkillSecurityEntry = {
      ...entry,
      status: 'rejected',
      revokedBy: revoker,
      revokedAt: new Date().toISOString(),
    };
    this.entries.set(skillId, updated);
    return updated;
  }

  verifyFingerprint(skillId: string, currentContent: string): FingerprintVerification {
    const entry = this.requireEntry(skillId);
    const actual = computeHash(currentContent);
    const valid = actual === entry.fingerprint.contentHash;
    if (!valid && entry.status === 'approved') {
      this.quarantine(skillId, [
        {
          pattern: 'fingerprint_mismatch',
          severity: 'critical',
          line: 0,
          context: `expected=${entry.fingerprint.contentHash.slice(0, 12)} actual=${actual.slice(0, 12)}`,
        },
      ]);
    }
    return { valid, expected: entry.fingerprint.contentHash, actual };
  }

  private requireEntry(skillId: string): SkillSecurityEntry {
    const entry = this.entries.get(skillId);
    if (!entry) throw new Error(`skill not found: ${skillId}`);
    return entry;
  }

  private assertNotTerminal(entry: SkillSecurityEntry): void {
    if (entry.status === 'rejected') {
      throw new Error(`skill ${entry.skillId} is rejected (terminal state). Re-install to re-enable.`);
    }
  }
}
