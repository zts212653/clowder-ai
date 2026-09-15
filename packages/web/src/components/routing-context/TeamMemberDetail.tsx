'use client';

import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { CatAvatar } from '@/components/CatAvatar';
import { RoutingSignalControls } from './RoutingSignalControls';
import { AvailabilityBadge, TeamEvidenceFold } from './TeamCandidatePresentation';
import type { TeamCapabilityReading, TeamMemberRow } from './team-member-projection';

function SignalList({ title, items, testId }: { title: string; items: readonly string[]; testId: string }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-4" data-testid={testId}>
      <h4 className="text-xs font-semibold text-cafe-black">{title}</h4>
      <ul className="mt-1.5 space-y-1 text-xs leading-5 text-cafe-secondary">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span aria-hidden="true" className="text-cafe-muted">
              ·
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * DossierCapabilityProfileRevisionSource reports 0 when the dossier entry carries no
 * provenance date. That is an applied revision with an unknown date — not the absence
 * of an applied revision, and the two must not read the same.
 */
function describeProfileBasis(capability: TeamCapabilityReading): string {
  if (capability.state !== 'applied') return '暂无已应用的画像版本';
  const updatedAt = capability.revision.updatedAt;
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '这一版画像没有记录依据日期';
  return `当前画像依据日期：${new Date(updatedAt).toISOString().slice(0, 10)}`;
}

export function TeamMemberDetail({
  row,
  model,
  onChanged,
}: {
  row: TeamMemberRow;
  model: RoutingContextReadModelV1;
  onChanged: () => Promise<boolean>;
}) {
  const { identity, capability, availability, candidate } = row;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <CatAvatar catId={identity.catId} size={56} />
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-cafe-black">{identity.displayName}</h3>
          {identity.secondaryLabel && <p className="text-xs text-cafe-muted">{identity.secondaryLabel}</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <AvailabilityBadge reading={availability} />
        <p className="text-xs text-cafe-secondary">{availability.impact}</p>
      </div>

      <section className="rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-4">
        {capability.state === 'applied' ? (
          <>
            <SignalList title="适合的任务" items={capability.fitSignals} testId="team-detail-fit" />
            <SignalList title="协作时留意" items={capability.watchOuts} testId="team-detail-cautions" />
            {capability.fitSignals.length === 0 && capability.watchOuts.length === 0 && (
              <p className="text-xs text-cafe-secondary">这一版画像里还没有可读的能力信号。</p>
            )}
          </>
        ) : (
          <>
            <h4 className="text-xs font-semibold text-cafe-black">能力资料待补充</h4>
            <p className="mt-1.5 text-xs leading-5 text-cafe-secondary">
              还没有整理好的能力画像。这不代表他做不了事，只代表我们还没有把依据写下来。
            </p>
          </>
        )}
        <div className="mt-4 border-t border-cafe-subtle pt-3">
          <h4 className="text-xs font-semibold text-cafe-black">近期表现与画像更新</h4>
          <p className="mt-1 text-micro leading-4 text-cafe-muted">
            {describeProfileBasis(capability)}
            {' · '}
            新记录经过整理和审阅后才会进入画像
          </p>
          <a
            href="/settings?s=profiles"
            className="mt-2 inline-flex text-micro font-semibold text-cafe-accent hover:underline"
            data-testid="team-open-dossier-source"
          >
            在设置中查看画像来源
          </a>
        </div>
        <TeamEvidenceFold candidate={candidate} capability={capability} />
      </section>

      <RoutingSignalControls
        subjectRef={{ type: 'cat', catId: identity.catId }}
        affectedCatIds={[identity.catId]}
        signalEvents={model.signalEvents}
        onChanged={onChanged}
      />
    </div>
  );
}
