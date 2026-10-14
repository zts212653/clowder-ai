import { formatHandle } from '../cat-handle';
import type { TeamHomeData } from '../types';

interface ActiveMissionsTableProps {
  missions: TeamHomeData['missions'];
}

const stageLabels: Record<TeamHomeData['missions'][number]['stage'], string> = {
  kickoff: '启动',
  impl: '实现',
  quality_gate: '质量门禁',
  review: 'Review',
  merge: 'Merge',
  completion: '完成',
};

export function ActiveMissionsTable({ missions }: ActiveMissionsTableProps) {
  if (missions.length === 0) {
    return (
      <section className="rounded-2xl bg-[var(--console-card-bg)] p-6 shadow-[var(--console-card-shadow)]">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-cafe-muted">Active Missions</h2>
        <p className="mt-4 text-center text-sm text-cafe-secondary">当前没有进行中的 mission</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-[var(--console-card-bg)] p-5 shadow-[var(--console-card-shadow)]">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-cafe-muted">Active Missions</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-cafe-muted">
              <th className="pb-2 font-medium">ID</th>
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">Owner</th>
              <th className="pb-2 font-medium">Stage</th>
              <th className="pb-2 font-medium">Evidence</th>
              <th className="pb-2 font-medium">Next Action</th>
            </tr>
          </thead>
          <tbody className="text-cafe">
            {missions.map((mission) => (
              <tr key={mission.id} className="border-t border-[var(--console-border-soft)]">
                <td className="py-2.5 font-mono text-xs text-cafe-secondary">{mission.id}</td>
                <td className="py-2.5">{mission.name}</td>
                <td className="py-2.5">{formatHandle(mission.owner)}</td>
                <td className="py-2.5">
                  <span className="rounded-md bg-[var(--console-shell-bg)] px-2 py-0.5 text-xs">
                    {stageLabels[mission.stage]}
                  </span>
                </td>
                <td className="py-2.5 text-xs text-cafe-secondary">
                  {mission.evidenceCount != null && mission.requiredEvidence != null
                    ? `${mission.evidenceCount}/${mission.requiredEvidence}`
                    : '—'}
                </td>
                <td className="max-w-xs truncate py-2.5 text-xs text-cafe-secondary">{mission.nextAction}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
