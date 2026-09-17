import type { EvolutionProgramStage, ExactAssetVersionRefV1, OwnerTruthRefV1 } from '@cat-cafe/shared';

export const PROGRAM_ID = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
export const ownerRef = (id: string): OwnerTruthRefV1 => ({ ownerFeatureId: 'F267', ownerStateRef: `proof:${id}` });
export const assetRef = (version: string, assetId = 'review-method'): ExactAssetVersionRefV1 => ({
  ownerFeatureId: 'F202',
  ownerStateRef: `skill:${assetId}`,
  assetKind: 'skill',
  assetId,
  version,
});

export function programFixture(stage: EvolutionProgramStage = 'constituting', sequence = 1) {
  return {
    program: {
      schemaVersion: 1 as const,
      programId: PROGRAM_ID,
      workspaceId: 'user:test',
      displayName: '研发协作改进',
      objectRef: ownerRef('研发协作改进'),
      claimRef: ownerRef('claim'),
      certificates: { goal: ownerRef('goal'), measurement: ownerRef('measurement'), economic: ownerRef('economic') },
      valueOwnerRef: ownerRef('value-owner'),
      measurementRoleRefs: {
        observer: ownerRef('observer'),
        domainOwner: ownerRef('domain'),
        consumer: ownerRef('consumer'),
        calibrator: ownerRef('calibrator'),
      },
      currentAssetVersionRefs: [assetRef('v1')],
      lifecycle: 'active' as const,
      stage,
      cycle: 1,
      sequence,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    },
    cycles: [{ programId: PROGRAM_ID, cycle: 1, stage, lineageRefIds: [], openedAt: '2026-09-05T00:00:00.000Z' }],
    drafts: {
      goal: ownerRef('goal-draft'),
      claim: ownerRef('claim-draft'),
      measurement: ownerRef('measurement-draft'),
      economic: ownerRef('economic-draft'),
      roles: {},
    },
    blockers: [],
    nextAction: { code: 'continue_stage', label: '继续当前阶段' },
    observation: { status: 'insufficient' as const, connectedEyes: [], gaps: [] },
    attribution: null,
    lineage: { cycles: [{ cycle: 1, changes: [] }] },
  };
}
