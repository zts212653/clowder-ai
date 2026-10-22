import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';

export function writeF311OwnerBindingFixture(root) {
  const programId = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
  const prefix =
    'docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs/evolution-program-bcc336788a7df9d6075b1efb4c0a7e68';
  const measurementRef =
    'docs/harness-feedback/measurement-sources/capability-evolution/evolution-program-bcc336788a7df9d6075b1efb4c0a7e68.yaml';
  const targetRef = { ownerFeatureId: 'F311', ownerStateRef: 'capability:f311-investor-roadshow-expression' };
  const valueOwnerRef = { ownerFeatureId: 'F311', ownerStateRef: 'user:default-user' };
  const domainOwnerRef = { ownerFeatureId: 'F311', ownerStateRef: 'capability-owner:fixture-domain' };
  const certificateRef = { ownerFeatureId: 'F311', ownerStateRef: `evolution-economic-certificate:${programId}:v1` };
  const sourceRefs = ['thread_fixture#message-fixture'];
  const decision = { consumerFeatureId: 'F311', consumerOwnerCatId: 'fixture-consumer' };
  const paths = ['charter', 'economic-certificate', 'measurement-role-assignment'].map(
    (kind) => `${prefix}-${kind}-v1.yaml`,
  );
  const bindingPath = `${prefix}-eval-repair-owner-binding-v1.yaml`;
  const objects = [
    [
      paths[0],
      {
        kind: 'f311-evolution-program-owner-charter',
        schemaVersion: 1,
        programId,
        targetRef,
        valueOwnerRef,
        economicCertificateRef: certificateRef,
      },
    ],
    [
      paths[1],
      {
        kind: 'f311-evolution-economic-certificate',
        schemaVersion: 1,
        programId,
        certificateRef,
        targetRef,
        valueOwnerRef,
        authorizationRefs: sourceRefs,
        notAuthorized: ['owner authorization remains missing in this independent fixture'],
      },
    ],
    [
      paths[2],
      {
        kind: 'f311-capability-evolution-measurement-role-assignment',
        schemaVersion: 1,
        programId,
        targetRef,
        roles: { consumer: valueOwnerRef, domainOwner: domainOwnerRef },
        certificateDecision: decision,
      },
    ],
    [
      measurementRef,
      {
        kind: 'f267-capability-evolution-measurement-source',
        schemaVersion: 1,
        ownerUserId: 'default-user',
        ownerFeatureId: 'F311',
        sourceArtifacts: paths.map((ref) => ({ ref })),
        program: { targetRef },
        roles: { consumer: valueOwnerRef, domainOwner: domainOwnerRef },
        certificate: { decision },
        result: { decision: { status: 'insufficient' }, actionProposal: { action: 'keep_observe' } },
        ownerObjects: [],
      },
    ],
    [
      bindingPath,
      {
        kind: 'f311-eval-repair-owner-binding',
        schemaVersion: 1,
        measurementSourceRef: measurementRef,
        programRef: { ownerFeatureId: 'F311', ownerStateRef: programId },
        targetRef,
        targetVersionRef: {
          ...targetRef,
          version: 'owner-binding-v1',
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
        truthBoundary: ['Synthetic owner inputs grant no intervention authority.'],
      },
    ],
  ];
  for (const [path, object] of objects) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), stringify(object));
  }
  return { bindingPath, charterPath: paths[0] };
}
