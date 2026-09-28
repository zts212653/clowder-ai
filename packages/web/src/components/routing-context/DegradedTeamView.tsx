'use client';

import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { CatAvatar } from '@/components/CatAvatar';
import type { TeamWorkspaceSubject } from '@/stores/chat-types';
import { RoutingPreferenceControls } from './RoutingPreferenceControls';
import { RoutingSignalControls } from './RoutingSignalControls';
import styles from './TeamWorkspacePanel.module.css';
import { buildTeamMemberIdentity, type TeamIdentitySource } from './team-member-projection';

/**
 * F293 AC-UX1 — a degraded routing read loses availability and capability, not identity.
 * The canonical catalog join still applies, so members stay recognisable while the
 * routing facts recover.
 */
export type GetTeamCat = (catId: string) => TeamIdentitySource | undefined;

export type DegradedRoutingContextReadModel = RoutingContextReadModelV1 & {
  resolution: Extract<RoutingContextReadModelV1['resolution'], { state: 'degraded' }>;
};

function DegradedNotice({
  model,
  getCatById,
  onRetry,
}: {
  model: DegradedRoutingContextReadModel;
  getCatById: GetTeamCat;
  onRetry: () => void;
}) {
  // Degraded routing is still the Team page: an affected member is a person here,
  // and the owner needs a way to try again without leaving the surface.
  const affected = model.resolution.affectedCatIds.map(
    (catId) => buildTeamMemberIdentity(catId, getCatById(catId)).displayName,
  );
  return (
    <div
      className="rounded-xl border border-conn-amber-ring bg-conn-amber-bg p-4 text-sm text-conn-amber-text"
      data-testid="team-degraded-notice"
    >
      <p>当前路由事实暂时不可完整读取；原有成员与目标不会被系统静默改派。</p>
      {affected.length > 0 && <p className="mt-1 text-micro">受影响成员：{affected.join('、')}</p>}
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 text-micro font-semibold underline"
        data-testid="team-degraded-retry"
      >
        重新读取
      </button>
    </div>
  );
}

function DegradedTeamList({
  model,
  getCatById,
  onSubjectChange,
  onChanged,
}: {
  model: DegradedRoutingContextReadModel;
  getCatById: GetTeamCat;
  onSubjectChange: (subject: TeamWorkspaceSubject) => void;
  onChanged: () => Promise<boolean>;
}) {
  return (
    <div className="space-y-6">
      <DegradedNotice model={model} getCatById={getCatById} onRetry={() => void onChanged()} />
      <RoutingPreferenceControls revisions={model.preferenceRevisions} onChanged={onChanged} />
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-cafe-black">成员</h3>
          <span className="text-micro text-cafe-muted">目录成员可见，路由状态待恢复</span>
        </div>
        <div className={styles.teamGrid} data-team-layout="container-driven">
          {model.resolution.candidateBindings.map((binding) => {
            const identity = buildTeamMemberIdentity(binding.catId, getCatById(binding.catId));
            return (
              <button
                key={binding.catId}
                type="button"
                onClick={() => onSubjectChange({ type: 'cat', id: binding.catId })}
                className="flex w-full items-center gap-3 rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-3.5 text-left transition-colors hover:border-cafe-accent/35 hover:bg-cafe-surface"
                data-testid={`team-cat-${binding.catId}`}
              >
                <CatAvatar catId={binding.catId} size={40} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-cafe-black">{identity.displayName}</span>
                  {identity.secondaryLabel && (
                    <span className="mt-0.5 block text-micro text-cafe-muted">{identity.secondaryLabel}</span>
                  )}
                  <span className="mt-2 block text-micro text-cafe-secondary">路由状态与能力依据暂不可完整读取</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function DegradedTeamDetail({
  model,
  subject,
  getCatById,
  onChanged,
}: {
  model: DegradedRoutingContextReadModel;
  subject: TeamWorkspaceSubject;
  getCatById: GetTeamCat;
  onChanged: () => Promise<boolean>;
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
      <DegradedNotice model={model} getCatById={getCatById} onRetry={() => void onChanged()} />
      <section className="rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-4">
        <h3 className="text-lg font-semibold text-cafe-black">
          {subject.type === 'cat'
            ? buildTeamMemberIdentity(subject.id, getCatById(subject.id)).displayName
            : subject.id}
        </h3>
        {matchingBindings.map((binding) => (
          <p key={binding.catId} className="mt-1 text-xs text-cafe-muted">
            {buildTeamMemberIdentity(binding.catId, getCatById(binding.catId)).displayName} · {binding.providerId}
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
  getCatById,
  onSubjectChange,
  onChanged,
}: {
  model: DegradedRoutingContextReadModel;
  subject: TeamWorkspaceSubject | null;
  getCatById: GetTeamCat;
  onSubjectChange: (subject: TeamWorkspaceSubject | null) => void;
  onChanged: () => Promise<boolean>;
}) {
  return subject ? (
    <DegradedTeamDetail model={model} subject={subject} getCatById={getCatById} onChanged={onChanged} />
  ) : (
    <DegradedTeamList model={model} getCatById={getCatById} onSubjectChange={onSubjectChange} onChanged={onChanged} />
  );
}
