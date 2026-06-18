import type { CatId } from '@cat-cafe/shared';

export type TeamHomeParticipantId = CatId | 'co-creator';

export type TeamHomeSOPStage = 'kickoff' | 'impl' | 'quality_gate' | 'review' | 'merge' | 'completion';

export type TeamHomeGateStatus = 'passed' | 'pending' | 'failed' | 'not_started';

export type TeamHomeRiskType = 'vision_drift' | 'no_evidence' | 'cross_thread_block' | 'unresolved_review';

export interface TeamHomeBaton {
  holder: TeamHomeParticipantId;
  scope: string;
  since: string;
  nextStep: string;
  nextOwner?: TeamHomeParticipantId;
  blocker: string | null;
}

export interface TeamHomeQualityGate {
  name: string;
  label: string;
  status: TeamHomeGateStatus;
  evidenceRef?: string;
  owner?: TeamHomeParticipantId;
}

export interface TeamHomeMember {
  id: TeamHomeParticipantId;
  name: string;
  role: 'agent' | 'human';
  currentContext: string;
  lastActiveAt: string;
  capabilities: string[];
}

export interface TeamHomeMissionSummary {
  id: string;
  name: string;
  owner: TeamHomeParticipantId;
  stage: TeamHomeSOPStage;
  evidenceCount: number;
  requiredEvidence: number;
  nextAction: string;
  updatedAt: string;
}

export interface TeamHomeCultureRule {
  id: string;
  text: string;
  active: boolean;
}

export interface TeamHomeDecisionItem {
  id: string;
  question: string;
  context: string;
  urgency: 'now' | 'this_week' | 'later';
  suggestedOptions?: string[];
}

export interface TeamHomeRisk {
  id: string;
  type: TeamHomeRiskType;
  message: string;
  relatedFeatureId?: string;
  severity: 'high' | 'medium' | 'low';
}

export interface TeamHomeMemoryItem {
  id: string;
  kind: 'lesson' | 'adr' | 'skill' | 'decision';
  title: string;
  anchor: string;
  createdAt: string;
}

export interface TeamHomeData {
  mission: {
    text: string;
    phase: TeamHomeSOPStage;
    activeFeatureId: string;
    truthSourceUrl?: string;
  };
  baton: TeamHomeBaton;
  qualityGates: TeamHomeQualityGate[];
  team: TeamHomeMember[];
  missions: TeamHomeMissionSummary[];
  culture: {
    headline: string;
    rules: TeamHomeCultureRule[];
  };
  cvoDecisions: TeamHomeDecisionItem[];
  risks: TeamHomeRisk[];
  recentMemory: TeamHomeMemoryItem[];
}
