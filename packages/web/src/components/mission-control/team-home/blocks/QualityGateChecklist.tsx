import { formatHandle } from '../cat-handle';
import type { TeamHomeData } from '../types';

interface QualityGateChecklistProps {
  gates: TeamHomeData['qualityGates'];
}

const statusIndicator: Record<TeamHomeData['qualityGates'][number]['status'], { dot: string; label: string }> = {
  passed: { dot: 'bg-[var(--semantic-success)]', label: '已通过' },
  pending: { dot: 'bg-[var(--semantic-warning)]', label: '进行中' },
  failed: { dot: 'bg-[var(--semantic-danger)]', label: '未通过' },
  not_started: { dot: 'bg-cafe-muted', label: '未开始' },
};

export function QualityGateChecklist({ gates }: QualityGateChecklistProps) {
  return (
    <section className="rounded-2xl bg-[var(--console-card-bg)] p-5 shadow-[var(--console-card-shadow)]">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-cafe-muted">Quality Gates</h2>
      <ul className="mt-3 space-y-2">
        {gates.map((gate) => {
          const { dot, label } = statusIndicator[gate.status];
          return (
            <li
              key={gate.name}
              className="flex items-center justify-between rounded-xl bg-[var(--console-shell-bg)] px-3 py-2"
            >
              <div className="flex items-center gap-2.5">
                <span className={`h-2 w-2 rounded-full ${dot}`} />
                <span className="text-sm text-cafe">{gate.label}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-cafe-secondary">
                <span>{label}</span>
                {gate.owner && <span>{formatHandle(gate.owner)}</span>}
                {gate.evidenceRef && (
                  <a
                    href={gate.evidenceRef}
                    className="text-cafe-secondary underline-offset-2 hover:text-cafe hover:underline"
                  >
                    证据
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
