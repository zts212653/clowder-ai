import type { TrustLevel } from './marketplace.js';

export type SkillSecurityStatus = 'pending_review' | 'approved' | 'quarantined' | 'rejected';

export interface SkillFingerprint {
  source: string;
  version: string;
  contentHash: string;
  recordedAt: string;
}

export interface ContentScanFinding {
  pattern: string;
  severity: 'critical' | 'warning';
  line: number;
  context: string;
}

export interface SkillSecurityEntry {
  skillId: string;
  status: SkillSecurityStatus;
  fingerprint: SkillFingerprint;
  scanFindings: ContentScanFinding[];
  approvedBy?: string;
  approvedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface InstallPolicy {
  autoInstallTrustLevels: TrustLevel[];
  denyInstallScripts: boolean;
  requireProbeBeforeReady: boolean;
}

export const DEFAULT_INSTALL_POLICY: InstallPolicy = {
  autoInstallTrustLevels: ['official', 'verified'],
  denyInstallScripts: true,
  requireProbeBeforeReady: true,
};

export interface PolicyEvaluation {
  allowed: boolean;
  reason?: 'community_requires_confirmation' | 'install_scripts_denied';
  requiredConfirmations?: string[];
}

export interface SkillPermissionSet {
  canWriteCapabilities: boolean;
  canTriggerSkills: boolean;
  toolAutoAllow: boolean;
  mode: 'full' | 'dry-run' | 'read-only';
}
