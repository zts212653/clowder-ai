const PROGRAM_ID = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
const PREFIX = PROGRAM_ID.replace(':', '-');
const INPUT_ROOT = 'docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs';
const MEASUREMENT_REF = `docs/harness-feedback/measurement-sources/capability-evolution/${PREFIX}.yaml`;

// Synthetic documents exercise the file-backed join without exporting installation evidence.
// The provider's canonical Program/target addresses are contract inputs, not captured owner data.
export function createF311ConsumerBindingFixture({ targetRef, valueOwnerRef, consumerRef }) {
  const domainOwnerRef = { ownerFeatureId: 'F311', ownerStateRef: 'capability-owner:synthetic' };
  const certificateRef = { ownerFeatureId: 'F311', ownerStateRef: 'economic-certificate:synthetic' };
  const sourceRefs = ['thread_synthetic#message-synthetic'];
  const charterRef = `${INPUT_ROOT}/${PREFIX}-charter-v1.yaml`;
  const economicRef = `${INPUT_ROOT}/${PREFIX}-economic-certificate-v1.yaml`;
  const rolesRef = `${INPUT_ROOT}/${PREFIX}-measurement-role-assignment-v1.yaml`;
  const decision = { consumerFeatureId: consumerRef.ownerFeatureId, consumerOwnerCatId: 'codex-sol' };
  const roles = { consumer: consumerRef, domainOwner: domainOwnerRef };
  return new Map([
    [
      charterRef,
      {
        kind: 'f311-evolution-program-owner-charter',
        schemaVersion: 1,
        programId: PROGRAM_ID,
        targetRef,
        valueOwnerRef,
        economicCertificateRef: certificateRef,
      },
    ],
    [
      economicRef,
      {
        kind: 'f311-evolution-economic-certificate',
        schemaVersion: 1,
        programId: PROGRAM_ID,
        certificateRef,
        targetRef,
        valueOwnerRef,
        authorizationRefs: sourceRefs,
        notAuthorized: ['Synthetic fixture supplies no owner authorization.'],
      },
    ],
    [
      rolesRef,
      {
        kind: 'f311-capability-evolution-measurement-role-assignment',
        schemaVersion: 1,
        programId: PROGRAM_ID,
        targetRef,
        roles,
        certificateDecision: decision,
      },
    ],
    [
      `${INPUT_ROOT}/${PREFIX}-eval-repair-owner-binding-v1.yaml`,
      {
        kind: 'f311-eval-repair-owner-binding',
        schemaVersion: 1,
        measurementSourceRef: MEASUREMENT_REF,
        programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
        targetRef,
        targetVersionRef: {
          ...targetRef,
          version: 'synthetic-v1',
          assetKind: 'capability',
          assetId: 'f311-investor-roadshow-expression',
        },
        valueOwnerRef,
        domainOwnerRef,
        ownerAuthorization: { status: 'missing', blockerRef: certificateRef, sourceRefs },
        lineageBindings: [],
        interventionReceipts: [],
        freshOutcomeReceipts: [],
        decisionReceipts: [],
        truthBoundary: ['Synthetic contract fixture; no real authorization or outcome.'],
      },
    ],
    [
      MEASUREMENT_REF,
      {
        kind: 'f267-capability-evolution-measurement-source',
        schemaVersion: 1,
        ownerUserId: valueOwnerRef.ownerStateRef.slice('user:'.length),
        ownerFeatureId: 'F311',
        sourceArtifacts: [charterRef, economicRef, rolesRef].map((ref) => ({ ref })),
        program: { targetRef },
        roles: structuredClone(roles),
        certificate: { decision },
        result: { decision: { status: 'insufficient' }, actionProposal: { action: 'keep_observe' } },
        ownerObjects: [],
      },
    ],
  ]);
}
