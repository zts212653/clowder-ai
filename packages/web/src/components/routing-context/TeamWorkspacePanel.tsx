'use client';

import type { RoutingContextReadModelV1, RoutingContextSnapshotV1 } from '@cat-cafe/shared';
import { useEffect, useMemo } from 'react';
import type { TeamWorkspaceSubject } from '@/stores/chat-types';
import type { DegradedRoutingContextReadModel } from './DegradedTeamView';
import { DegradedTeamView } from './DegradedTeamView';
import { RoutingPreferenceControls } from './RoutingPreferenceControls';
import { RoutingSignalControls } from './RoutingSignalControls';
import styles from './TeamWorkspacePanel.module.css';
import { resolveTeamWorkspaceSubject } from './team-navigation';
import { useRoutingContext } from './useRoutingContext';

type Candidate = RoutingContextSnapshotV1['candidates'][number];

const AVAILABILITY_LABELS: Record<Candidate['availability'], string> = {
  available: '可用',
  scarce: '需节制',
  degraded: '能力降级',
  unavailable: '暂不可用',
  unknown: '状态未知',
};

const AVAILABILITY_CLASS: Record<Candidate['availability'], string> = {
  available: 'border-conn-green-ring bg-conn-green-bg text-conn-green-text',
  scarce: 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
  degraded: 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
  unavailable: 'border-conn-red-ring bg-conn-red-bg text-conn-red-text',
  unknown: 'border-cafe-subtle bg-cafe-surface-sunken text-cafe-secondary',
};

function AvailabilityBadge({ candidate }: { candidate: Candidate }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-micro font-semibold ${AVAILABILITY_CLASS[candidate.availability]}`}
      data-routing-availability={candidate.availability}
    >
      {AVAILABILITY_LABELS[candidate.availability]}
    </span>
  );
}

function ProfileBasis({ candidate }: { candidate: Candidate }) {
  if (candidate.profile.state !== 'applied') {
    return <p className="mt-2 text-micro leading-4 text-cafe-muted">尚无已应用的能力画像</p>;
  }
  const signals = candidate.profile.revision.relevantSignals;
  return (
    <div className="mt-2 space-y-1">
      <p className="text-micro text-cafe-muted">
        {candidate.profile.revision.modelId} · {candidate.profile.revision.dossierRevision}
      </p>
      {signals.slice(0, 2).map((signal) => (
        <p key={`${signal.kind}:${signal.summary}`} className="text-micro leading-4 text-cafe-secondary">
          {signal.summary}
        </p>
      ))}
    </div>
  );
}

function CandidateCard({ candidate, onSelect }: { candidate: Candidate; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-3.5 text-left transition-colors hover:border-cafe-accent/35 hover:bg-cafe-surface"
      data-testid={`team-cat-${candidate.binding.catId}`}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-cafe-black">{candidate.binding.catId}</span>
          <span className="mt-0.5 block text-micro text-cafe-muted">{candidate.binding.providerId}</span>
        </span>
        <AvailabilityBadge candidate={candidate} />
      </span>
      <ProfileBasis candidate={candidate} />
    </button>
  );
}

function ProviderCard({ providerId, cats, onSelect }: { providerId: string; cats: Candidate[]; onSelect: () => void }) {
  const blocked = cats.filter((candidate) => candidate.effect === 'blocked').length;
  const unknown = cats.filter((candidate) => candidate.availability === 'unknown').length;
  const advisory = cats.filter(
    (candidate) => candidate.availability === 'scarce' || candidate.availability === 'degraded',
  ).length;
  const status =
    [
      blocked > 0 ? `${blocked} 位阻塞` : '',
      advisory > 0 ? `${advisory} 位需关注` : '',
      unknown > 0 ? `${unknown} 位状态未知` : '',
    ]
      .filter(Boolean)
      .join(' · ') || '运行中';
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center justify-between gap-3 rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-3.5 text-left transition-colors hover:border-cafe-accent/35 hover:bg-cafe-surface"
      data-testid={`team-provider-${providerId}`}
    >
      <span>
        <span className="block text-sm font-semibold text-cafe-black">{providerId}</span>
        <span className="mt-0.5 block text-micro text-cafe-muted">{cats.length} 位成员使用此 runtime</span>
      </span>
      <span className="text-micro font-semibold text-cafe-secondary">{status}</span>
    </button>
  );
}

function TeamList({
  model,
  onSubjectChange,
  onChanged,
}: {
  model: RoutingContextReadModelV1;
  onSubjectChange: (subject: TeamWorkspaceSubject) => void;
  onChanged: () => Promise<void>;
}) {
  if (model.resolution.state === 'degraded') {
    return (
      <div className="rounded-xl border border-conn-amber-ring bg-conn-amber-bg p-4 text-sm text-conn-amber-text">
        当前路由事实暂时不可完整读取；原有成员与目标不会被系统静默改派。
      </div>
    );
  }
  const candidates = model.resolution.snapshot.candidates;
  const providers = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = providers.get(candidate.binding.providerId) ?? [];
    group.push(candidate);
    providers.set(candidate.binding.providerId, group);
  }
  if (candidates.length === 0) {
    return (
      <div className="space-y-6">
        <RoutingPreferenceControls revisions={model.preferenceRevisions} onChanged={onChanged} />
        <div className="rounded-xl border border-dashed border-cafe-subtle px-4 py-10 text-center text-xs text-cafe-secondary">
          当前目录还没有可展示的团队成员
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <RoutingPreferenceControls revisions={model.preferenceRevisions} onChanged={onChanged} />
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-cafe-black">成员</h3>
          <span className="text-micro text-cafe-muted">可用性来自实时 routing read model</span>
        </div>
        <div className={styles.teamGrid} data-team-layout="container-driven">
          {candidates.map((candidate) => (
            <CandidateCard
              key={candidate.binding.catId}
              candidate={candidate}
              onSelect={() => onSubjectChange({ type: 'cat', id: candidate.binding.catId })}
            />
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold text-cafe-black">Runtime</h3>
        <div className={styles.teamGrid}>
          {[...providers].map(([providerId, cats]) => (
            <ProviderCard
              key={providerId}
              providerId={providerId}
              cats={cats}
              onSelect={() => onSubjectChange({ type: 'provider', id: providerId })}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function CandidateDetail({
  candidate,
  model,
  onChanged,
}: {
  candidate: Candidate;
  model: RoutingContextReadModelV1;
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-cafe-black">{candidate.binding.catId}</h3>
          <p className="text-xs text-cafe-muted">{candidate.binding.providerId}</p>
        </div>
        <AvailabilityBadge candidate={candidate} />
      </div>
      <section className="rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-4">
        <h4 className="text-xs font-semibold text-cafe-black">判断依据</h4>
        <div className="mt-2 space-y-2">
          {candidate.reasons.length > 0 ? (
            candidate.reasons.map((reason) => (
              <div key={`${reason.code}:${reason.summary}`}>
                <p className="text-xs text-cafe-secondary">{reason.summary}</p>
                <p className="mt-0.5 text-micro text-cafe-muted">
                  {reason.code} · {reason.sourceRefs.join(' · ')}
                </p>
              </div>
            ))
          ) : (
            <p className="text-xs text-cafe-secondary">当前没有异常理由。</p>
          )}
        </div>
      </section>
      <section className="rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-4">
        <h4 className="text-xs font-semibold text-cafe-black">已应用能力画像</h4>
        <ProfileBasis candidate={candidate} />
        <a
          href="/settings?s=profiles"
          className="mt-3 inline-flex text-micro font-semibold text-cafe-accent hover:underline"
          data-testid="team-open-dossier-source"
        >
          在设置中查看画像来源
        </a>
      </section>
      <RoutingSignalControls
        subjectRef={{ type: 'cat', catId: candidate.binding.catId }}
        affectedCatIds={[candidate.binding.catId]}
        signalEvents={model.signalEvents}
        onChanged={onChanged}
      />
    </div>
  );
}

function TeamDetail({
  model,
  subject,
  onChanged,
}: {
  model: RoutingContextReadModelV1;
  subject: TeamWorkspaceSubject;
  onChanged: () => Promise<void>;
}) {
  if (model.resolution.state === 'degraded') {
    return <p className="text-sm text-cafe-secondary">详情暂时不可刷新；已保留原 subject，没有改派或猜测替代对象。</p>;
  }
  const candidates = model.resolution.snapshot.candidates;
  if (subject.type === 'cat') {
    const candidate = candidates.find((item) => item.binding.catId === subject.id);
    return candidate ? <CandidateDetail candidate={candidate} model={model} onChanged={onChanged} /> : null;
  }
  const providerCandidates = candidates.filter((item) => item.binding.providerId === subject.id);
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold text-cafe-black">{subject.id}</h3>
        <p className="text-xs text-cafe-muted">{providerCandidates.length} 位成员绑定此 runtime</p>
      </div>
      {providerCandidates.map((candidate) => (
        <div
          key={candidate.binding.catId}
          className="rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-3.5"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-cafe-black">{candidate.binding.catId}</span>
            <AvailabilityBadge candidate={candidate} />
          </div>
        </div>
      ))}
      <RoutingSignalControls
        subjectRef={{ type: 'provider', providerId: subject.id }}
        affectedCatIds={providerCandidates.map((candidate) => candidate.binding.catId)}
        signalEvents={model.signalEvents}
        onChanged={onChanged}
      />
    </div>
  );
}

function TeamWorkspaceBody({
  data,
  loading,
  error,
  resolvedSubject,
  onSubjectChange,
  refresh,
}: {
  data: RoutingContextReadModelV1 | null;
  loading: boolean;
  error: string | null;
  resolvedSubject: TeamWorkspaceSubject | null;
  onSubjectChange: (subject: TeamWorkspaceSubject | null) => void;
  refresh: () => Promise<void>;
}) {
  if (loading && !data) {
    return (
      <div className="space-y-2" data-testid="team-loading">
        <div className="h-20 animate-pulse rounded-xl bg-cafe-surface-sunken" />
        <div className="h-20 animate-pulse rounded-xl bg-cafe-surface-sunken" />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="rounded-xl border border-conn-red-ring bg-conn-red-bg p-4 text-sm text-conn-red-text">
        <p>{error}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-3 font-semibold underline"
          data-testid="team-retry"
        >
          重新读取
        </button>
      </div>
    );
  }
  if (!data) return null;
  if (data.resolution.state === 'degraded') {
    return (
      <DegradedTeamView
        model={data as DegradedRoutingContextReadModel}
        subject={resolvedSubject}
        onSubjectChange={onSubjectChange}
        onChanged={refresh}
      />
    );
  }
  return resolvedSubject ? (
    <TeamDetail model={data} subject={resolvedSubject} onChanged={refresh} />
  ) : (
    <TeamList model={data} onSubjectChange={onSubjectChange} onChanged={refresh} />
  );
}

export function TeamWorkspacePanel({
  subject,
  onSubjectChange,
}: {
  subject: TeamWorkspaceSubject | null;
  onSubjectChange: (subject: TeamWorkspaceSubject | null) => void;
}) {
  const { data, loading, error, refresh } = useRoutingContext();
  const resolvedSubject = useMemo(() => (data ? resolveTeamWorkspaceSubject(subject, data) : subject), [data, subject]);

  useEffect(() => {
    if (data?.resolution.state === 'fresh' && subject && !resolvedSubject) onSubjectChange(null);
  }, [data, onSubjectChange, resolvedSubject, subject]);

  return (
    <div className={`${styles.root} min-h-0 flex-1 overflow-y-auto`} data-testid="team-workspace-panel">
      <div className="mx-auto w-full max-w-5xl p-4 sm:p-5">
        {resolvedSubject && (
          <button
            type="button"
            onClick={() => onSubjectChange(null)}
            className="mb-4 inline-flex items-center gap-1 text-xs font-semibold text-cafe-accent hover:underline"
            data-testid="team-detail-back"
          >
            <span aria-hidden="true">←</span> 返回团队
          </button>
        )}
        <TeamWorkspaceBody
          data={data}
          loading={loading}
          error={error}
          resolvedSubject={resolvedSubject}
          onSubjectChange={onSubjectChange}
          refresh={refresh}
        />
      </div>
    </div>
  );
}
