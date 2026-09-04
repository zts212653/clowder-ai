const envelope = Object.freeze({
  subjectRef: 'task:work:tomorrows-ppt',
  ownerRef: 'task:item:tomorrows-ppt',
  admissionReceiptRef: 'task:receipt:tomorrows-ppt:7',
  sourceRefs: Object.freeze(['message:tomorrows-ppt']),
  revision: 7,
  freshness: Object.freeze({ state: 'current', observedRevision: 7 }),
  visibility: Object.freeze({ ownerUserId: 'operator', human: true, cat: true }),
});

const preparedArtifact = Object.freeze({
  artifactRef: 'artifact:ppt:tomorrows-ppt',
  artifactRevision: '7',
  completenessRef: 'artifact:ppt:tomorrows-ppt#completeness:7',
  previewRef: 'artifact:ppt:tomorrows-ppt#preview:7',
  openInWorkspaceRef: 'workspace:artifact:ppt:tomorrows-ppt:7',
});

const timeRefs = Object.freeze([
  Object.freeze({
    role: 'business_deadline',
    subjectRef: 'task:work:tomorrows-ppt',
    ownerRef: 'task:item:tomorrows-ppt',
    revision: 7,
    value: 1_788_278_400_000,
  }),
  Object.freeze({
    role: 'review_by',
    subjectRef: 'task:work:tomorrows-ppt',
    ownerRef: 'task:item:tomorrows-ppt',
    revision: 7,
    value: 1_788_235_200_000,
  }),
  Object.freeze({
    role: 'execution_trigger',
    subjectRef: envelope.subjectRef,
    ownerRef: envelope.ownerRef,
    revision: envelope.revision,
    value: 1_788_231_600_000,
  }),
]);

function snapshot(attentionReceipt) {
  const actionable = attentionReceipt.eligible;
  const producerRef = attentionReceipt.producer.ownerRef;
  const producerRevision = attentionReceipt.producer.revision;
  return Object.freeze({
    envelope,
    brief: Object.freeze({
      outcome: Object.freeze({
        state: 'known',
        value: 'A reviewable presentation for tomorrow',
        ownerRef: envelope.ownerRef,
        revision: envelope.revision,
      }),
      current: Object.freeze({ state: 'doing', ownerRef: envelope.ownerRef, revision: envelope.revision }),
      verifiedMilestone: Object.freeze(
        actionable
          ? { kind: 'needs_judgment', evidenceRef: producerRef, revision: producerRevision }
          : {
              kind: 'artifact_ready',
              evidenceRef: preparedArtifact.completenessRef,
              revision: preparedArtifact.artifactRevision,
            },
      ),
      nextOwner: Object.freeze(
        actionable
          ? {
              kind: 'human',
              ownerRef: 'user:operator',
              evidence: [
                {
                  producerId: attentionReceipt.producer.producerId,
                  ownerRef: producerRef,
                  revision: producerRevision,
                },
              ],
            }
          : { kind: 'cat', ownerRef: 'cat:codex-sol', evidenceRef: envelope.ownerRef, revision: envelope.revision },
      ),
      needsMe: Object.freeze(
        actionable
          ? {
              state: 'needed',
              evidence: [
                {
                  producerId: attentionReceipt.producer.producerId,
                  ownerRef: producerRef,
                  revision: producerRevision,
                },
              ],
            }
          : { state: 'not_needed', evidenceRef: envelope.ownerRef, revision: envelope.revision },
      ),
    }),
    preparedArtifact,
    timeRefs,
    attentionReceipts: Object.freeze([Object.freeze(attentionReceipt)]),
  });
}

const quiet = snapshot({
  eligible: false,
  producer: Object.freeze({
    producerId: 'f246.approval',
    ownerRef: 'approval:proposal:ppt-direction',
    subjectRef: 'approval:proposal:ppt-direction',
    revision: 11,
  }),
  taskRef: Object.freeze({ subjectRef: envelope.subjectRef, observedRevision: envelope.revision }),
  reEvaluateActionRef: 'approval:proposal:ppt-direction#reevaluate',
});

const actionable = snapshot({
  eligible: true,
  producer: Object.freeze({
    producerId: 'f246.approval',
    ownerRef: 'approval:proposal:ppt-direction',
    subjectRef: 'approval:proposal:ppt-direction',
    revision: 12,
  }),
  taskRef: Object.freeze({ subjectRef: envelope.subjectRef, observedRevision: envelope.revision }),
  kind: 'judgment',
  reasonCode: 'artifact_direction_choice',
  recommendation: 'Use the evidence-first narrative',
  salience: 'normal',
  action: Object.freeze({
    actionRef: 'approval:proposal:ppt-direction#decide',
    expectedProducerRevision: 12,
  }),
  reEvaluateActionRef: 'approval:proposal:ppt-direction#reevaluate',
});

const resolved = snapshot({
  eligible: false,
  producer: Object.freeze({
    producerId: 'f246.approval',
    ownerRef: 'approval:proposal:ppt-direction',
    subjectRef: 'approval:proposal:ppt-direction',
    revision: 13,
  }),
  taskRef: Object.freeze({ subjectRef: envelope.subjectRef, observedRevision: envelope.revision }),
  reEvaluateActionRef: 'approval:proposal:ppt-direction#reevaluate',
});

export const tomorrowsPptOwnerReadFixture = Object.freeze({
  fixtureClass: 'deterministic_contract_fixture',
  runtimeEpisode: false,
  utilityEvidence: false,
  snapshots: Object.freeze({ quiet, actionable, resolved }),
  projectionRefs: Object.freeze({
    webSchedule: '#/snapshots/actionable',
    webNeedsMe: '#/snapshots/actionable',
    catOwnerRead: '#/snapshots/actionable',
  }),
});
