import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { EntrustedWorkBrief } from '@/components/growing/EntrustedWorkBrief';

function ownerRead(mode: 'quiet' | 'needs-human' | 'unknown'): EntrustedWorkOwnerReadV1 {
  const subjectRef = `task:work:preview-${mode}`;
  const ownerRef = `task:item:preview-${mode}`;
  const artifactRef = `artifact:ppt:preview-${mode}`;
  const producerRef = `interaction:preview-${mode}`;
  const needsHuman = mode === 'needs-human';
  const unknown = mode === 'unknown';
  const preparedArtifact = unknown
    ? undefined
    : {
        artifactRef,
        artifactRevision: '7',
        completenessRef: `${artifactRef}#complete:7`,
        previewRef: `${artifactRef}#preview:7`,
        openInWorkspaceRef: `workspace:${artifactRef}:7`,
      };
  const attentionReceipts: EntrustedWorkOwnerReadV1['attentionReceipts'] = needsHuman
    ? [
        {
          eligible: true,
          producer: {
            producerId: 'f306.runtime_interaction',
            ownerRef: producerRef,
            subjectRef: producerRef,
            revision: 12,
          },
          taskRef: { subjectRef, observedRevision: 4 },
          kind: 'judgment',
          reasonCode: 'runtime_interaction:choice',
          recommendation: 'Choose the evidence-first storyline',
          salience: 'normal',
          action: { actionRef: `${producerRef}#decide`, expectedProducerRevision: 12 },
          reEvaluateActionRef: `${producerRef}#reevaluate`,
        },
      ]
    : [];

  return {
    envelope: {
      subjectRef,
      ownerRef,
      admissionReceiptRef: `task:receipt:preview-${mode}:4`,
      sourceRefs: [`message:preview:${mode}`],
      revision: 4,
      freshness: { state: 'current', observedRevision: 4 },
      visibility: { ownerUserId: 'owner-preview', human: true, cat: true },
    },
    brief: {
      outcome: unknown
        ? { state: 'unknown' }
        : {
            state: 'known',
            value: 'A reviewable partner presentation is ready',
            ownerRef,
            revision: 4,
          },
      current: { state: 'doing', ownerRef, revision: 4 },
      verifiedMilestone: unknown
        ? { kind: 'unknown' }
        : needsHuman
          ? { kind: 'needs_judgment', evidenceRef: producerRef, revision: 12 }
          : { kind: 'artifact_ready', evidenceRef: `${artifactRef}#complete:7`, revision: '7' },
      nextOwner: unknown
        ? { kind: 'unknown' }
        : needsHuman
          ? {
              kind: 'human',
              ownerRef: 'user:owner-preview',
              evidence: [{ producerId: 'f306.runtime_interaction', ownerRef: producerRef, revision: 12 }],
            }
          : { kind: 'cat', ownerRef: 'cat:codex-sol', evidenceRef: ownerRef, revision: 4 },
      needsMe: needsHuman
        ? {
            state: 'needed',
            evidence: [{ producerId: 'f306.runtime_interaction', ownerRef: producerRef, revision: 12 }],
          }
        : { state: 'not_needed', evidenceRef: ownerRef, revision: 4 },
    },
    ...(preparedArtifact ? { preparedArtifact } : {}),
    timeRefs: [
      {
        role: 'review_by',
        subjectRef,
        ownerRef,
        revision: 4,
        value: Date.UTC(2026, 8, 3, 18),
      },
    ],
    attentionReceipts,
  };
}

const cases = [
  { label: 'Quiet progress', read: ownerRead('quiet') },
  { label: 'Needs You', read: ownerRead('needs-human') },
  { label: 'Honest unknown', read: ownerRead('unknown') },
];

export default function F310ReadableReturnPreview() {
  return (
    <main
      className="min-h-screen bg-cafe-surface p-4 text-cafe-black sm:p-8"
      data-testid="f310-readable-return-preview"
    >
      <div className="mx-auto max-w-5xl">
        <p className="text-micro font-bold uppercase tracking-[0.16em] text-cafe-accent">F310 dev-only fixture</p>
        <h1 className="mt-1 text-xl font-semibold">Readable return states</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-cafe-secondary">
          Disposable visual evidence only. These fixtures are not runtime episodes or a second progress store.
        </p>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {cases.map(({ label, read }) => (
            <article
              key={label}
              className="min-w-0 rounded-2xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4"
            >
              <h2 className="text-sm font-semibold text-cafe-black">{label}</h2>
              <EntrustedWorkBrief ownerRead={read} />
            </article>
          ))}
        </div>

        <section className="mt-6 max-w-[390px] rounded-2xl border border-cafe-subtle bg-[var(--console-card-bg)] p-3">
          <h2 className="text-sm font-semibold text-cafe-black">390px narrow-panel proof</h2>
          <EntrustedWorkBrief ownerRead={ownerRead('needs-human')} />
        </section>
      </div>
    </main>
  );
}
