'use client';

import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import type { TeamWorkspaceSubject } from '@/stores/chat-types';
import { RoutingPreferenceControls } from './RoutingPreferenceControls';
import { RoutingSignalControls } from './RoutingSignalControls';
import styles from './TeamWorkspacePanel.module.css';

export type DegradedRoutingContextReadModel = RoutingContextReadModelV1 & {
  resolution: Extract<RoutingContextReadModelV1['resolution'], { state: 'degraded' }>;
};

function DegradedNotice({ model }: { model: DegradedRoutingContextReadModel }) {
  return (
    <div className="rounded-xl border border-conn-amber-ring bg-conn-amber-bg p-4 text-sm text-conn-amber-text">
      <p>当前路由事实暂时不可完整读取；原有成员与目标不会被系统静默改派。</p>
      {model.resolution.affectedCatIds.length > 0 && (
        <p className="mt-1 text-micro">受影响成员：{model.resolution.affectedCatIds.join('、')}</p>
      )}
    </div>
  );
}

function DegradedTeamList({
  model,
  onSubjectChange,
  onChanged,
}: {
  model: DegradedRoutingContextReadModel;
  onSubjectChange: (subject: TeamWorkspaceSubject) => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="space-y-6">
      <DegradedNotice model={model} />
      <RoutingPreferenceControls revisions={model.preferenceRevisions} onChanged={onChanged} />
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-cafe-black">成员</h3>
          <span className="text-micro text-cafe-muted">目录成员可见，路由状态待恢复</span>
        </div>
        <div className={styles.teamGrid} data-team-layout="container-driven">
          {model.resolution.candidateBindings.map((binding) => (
            <button
              key={binding.catId}
              type="button"
              onClick={() => onSubjectChange({ type: 'cat', id: binding.catId })}
              className="w-full rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-3.5 text-left transition-colors hover:border-cafe-accent/35 hover:bg-cafe-surface"
              data-testid={`team-cat-${binding.catId}`}
            >
              <span className="block text-sm font-semibold text-cafe-black">{binding.catId}</span>
              <span className="mt-0.5 block text-micro text-cafe-muted">{binding.providerId}</span>
              <span className="mt-2 block text-micro text-cafe-secondary">路由状态与能力依据暂不可完整读取</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function DegradedTeamDetail({
  model,
  subject,
  onChanged,
}: {
  model: DegradedRoutingContextReadModel;
  subject: TeamWorkspaceSubject;
  onChanged: () => Promise<void>;
}) {
  const matchingBindings = model.resolution.candidateBindings.filter((binding) =>
    subject.type === 'cat' ? binding.catId === subject.id : binding.providerId === subject.id,
  );
  const subjectRef =
    subject.type === 'cat'
      ? ({ type: 'cat', catId: subject.id } as const)
      : ({ type: 'provider', providerId: subject.id } as const);
  return (
    <div className="space-y-4">
      <DegradedNotice model={model} />
      <section className="rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-4">
        <h3 className="text-lg font-semibold text-cafe-black">{subject.id}</h3>
        {matchingBindings.map((binding) => (
          <p key={binding.catId} className="mt-1 text-xs text-cafe-muted">
            {binding.catId} · {binding.providerId}
          </p>
        ))}
        <p className="mt-3 text-xs text-cafe-secondary">详情暂时不可刷新；已保留原 subject，没有改派或猜测替代对象。</p>
      </section>
      <RoutingSignalControls
        subjectRef={subjectRef}
        affectedCatIds={matchingBindings.map((binding) => binding.catId)}
        signalEvents={model.signalEvents}
        onChanged={onChanged}
      />
    </div>
  );
}

export function DegradedTeamView({
  model,
  subject,
  onSubjectChange,
  onChanged,
}: {
  model: DegradedRoutingContextReadModel;
  subject: TeamWorkspaceSubject | null;
  onSubjectChange: (subject: TeamWorkspaceSubject | null) => void;
  onChanged: () => Promise<void>;
}) {
  return subject ? (
    <DegradedTeamDetail model={model} subject={subject} onChanged={onChanged} />
  ) : (
    <DegradedTeamList model={model} onSubjectChange={onSubjectChange} onChanged={onChanged} />
  );
}
