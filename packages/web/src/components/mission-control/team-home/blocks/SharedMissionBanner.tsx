import type { TeamHomeData } from '../types';

interface SharedMissionBannerProps {
  mission: TeamHomeData['mission'];
}

const stageLabels: Record<TeamHomeData['mission']['phase'], string> = {
  kickoff: '启动',
  impl: '实现',
  quality_gate: '质量门禁',
  review: 'Review',
  merge: 'Merge',
  completion: '完成',
};

export function SharedMissionBanner({ mission }: SharedMissionBannerProps) {
  return (
    <section className="rounded-2xl bg-[var(--console-card-bg)] p-6 shadow-[var(--console-card-shadow)]">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-cafe-muted">Shared Mission</h2>
      <p className="mt-2 text-lg font-medium leading-relaxed text-cafe">{mission.text}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-cafe-secondary">
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--console-shell-bg)] px-2.5 py-1">
          Phase:
          <span className="font-medium text-cafe">{stageLabels[mission.phase]}</span>
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--console-shell-bg)] px-2.5 py-1">
          Feature:
          <span className="font-medium text-cafe">{mission.activeFeatureId}</span>
        </span>
        {mission.truthSourceUrl && (
          <a
            href={mission.truthSourceUrl}
            className="rounded-lg px-2.5 py-1 text-cafe-secondary underline-offset-2 hover:bg-[var(--console-hover-bg)] hover:text-cafe hover:underline"
          >
            真相源 →
          </a>
        )}
      </div>
    </section>
  );
}
