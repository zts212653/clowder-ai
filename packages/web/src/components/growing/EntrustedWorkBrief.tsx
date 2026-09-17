import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';

const CURRENT_LABELS = {
  todo: '已接住，待开始',
  doing: '正在推进',
  blocked: '已阻塞',
} as const;

const TIME_MILESTONE_LABELS = {
  business_deadline: '业务时间已确认',
  review_by: '审阅时间已确认',
  execution_trigger: '执行时间已确认',
} as const;

function milestoneLabel(brief: EntrustedWorkOwnerReadV1['brief']): string {
  const milestone = brief.verifiedMilestone;
  if (milestone.kind === 'needs_judgment') return '已到需要你判断的节点';
  if (milestone.kind === 'artifact_ready') return 'Artifact 已可查看';
  if (milestone.kind === 'time_committed') return TIME_MILESTONE_LABELS[milestone.role];
  if (milestone.kind === 'custody_admitted') return '托付已进入 Task';
  return 'unknown';
}

function nextOwnerLabel(nextOwner: EntrustedWorkOwnerReadV1['brief']['nextOwner']): string {
  if (nextOwner.kind === 'human') return 'You';
  if (nextOwner.kind === 'cat') return nextOwner.ownerRef.replace(/^cat:/, '');
  return 'unknown';
}

function milestoneEvidence(brief: EntrustedWorkOwnerReadV1['brief']): string {
  const milestone = brief.verifiedMilestone;
  return milestone.kind === 'unknown' ? 'unknown' : `${milestone.evidenceRef} · r${milestone.revision}`;
}

function nextOwnerEvidence(nextOwner: EntrustedWorkOwnerReadV1['brief']['nextOwner']): string {
  if (nextOwner.kind === 'unknown') return 'unknown';
  if (nextOwner.kind === 'cat') return `${nextOwner.evidenceRef} · r${nextOwner.revision}`;
  return nextOwner.evidence
    .map((evidence) => `${evidence.producerId} · ${evidence.ownerRef} · r${evidence.revision}`)
    .join(' / ');
}

export function EntrustedWorkBrief({ ownerRead }: { ownerRead: EntrustedWorkOwnerReadV1 }) {
  const { brief, preparedArtifact } = ownerRead;
  const outcome = brief.outcome.state === 'known' ? brief.outcome.value : 'unknown';
  const artifact = preparedArtifact
    ? `Artifact r${preparedArtifact.artifactRevision} · ${preparedArtifact.artifactRef}`
    : 'unknown';

  return (
    <section
      className="mt-3 min-w-0 rounded-xl border border-cafe-subtle/70 bg-cafe-surface/55 p-3"
      data-testid="entrusted-work-brief"
      data-task-revision={ownerRead.envelope.revision}
    >
      <p className="text-micro font-bold uppercase tracking-[0.12em] text-cafe-muted">十秒读懂</p>
      <p className="mt-1 break-words text-sm font-medium leading-5 text-cafe-black">
        <span className="text-cafe-muted">目标 · </span>
        {outcome}
      </p>

      <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-micro font-medium text-cafe-muted">当前</dt>
          <dd className="mt-0.5 break-words text-xs font-semibold text-cafe-black">
            {CURRENT_LABELS[brief.current.state]}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro font-medium text-cafe-muted">已验证</dt>
          <dd className="mt-0.5 break-words text-xs font-semibold text-cafe-black">{milestoneLabel(brief)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro font-medium text-cafe-muted">下一步</dt>
          <dd className="mt-0.5 break-words text-xs font-semibold text-cafe-black">
            {nextOwnerLabel(brief.nextOwner)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro font-medium text-cafe-muted">Needs Me</dt>
          <dd className="mt-0.5 break-words text-xs font-semibold text-cafe-black">
            {brief.needsMe.state === 'needed'
              ? '现在需要你'
              : brief.needsMe.state === 'not_needed'
                ? '现在不需要你'
                : 'unknown'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-micro font-medium text-cafe-muted">Artifact</dt>
          <dd
            className="mt-0.5 break-all text-xs font-semibold text-cafe-black"
            data-testid="entrusted-work-brief-artifact"
          >
            {artifact}
          </dd>
        </div>
      </dl>

      <details className="mt-3 min-w-0 border-t border-cafe-subtle/60 pt-2 text-micro text-cafe-muted">
        <summary className="cursor-pointer font-medium text-cafe-secondary">查看 owner refs / revisions</summary>
        <dl className="mt-2 grid min-w-0 gap-1.5">
          <div className="min-w-0 break-all">
            <dt className="inline font-medium">Task · </dt>
            <dd className="inline">
              {ownerRead.envelope.ownerRef} · r{ownerRead.envelope.revision}
            </dd>
          </div>
          <div className="min-w-0 break-all">
            <dt className="inline font-medium">Milestone · </dt>
            <dd className="inline">{milestoneEvidence(brief)}</dd>
          </div>
          <div className="min-w-0 break-all">
            <dt className="inline font-medium">Next owner · </dt>
            <dd className="inline">{nextOwnerEvidence(brief.nextOwner)}</dd>
          </div>
          <div className="min-w-0 break-all">
            <dt className="inline font-medium">Artifact · </dt>
            <dd className="inline">{preparedArtifact?.artifactRef ?? 'unknown'}</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
