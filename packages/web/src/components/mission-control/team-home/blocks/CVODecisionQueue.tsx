import type { TeamHomeData } from '../types';

interface CVODecisionQueueProps {
  items: TeamHomeData['cvoDecisions'];
}

const urgencyLabels: Record<TeamHomeData['cvoDecisions'][number]['urgency'], string> = {
  now: '现在',
  this_week: '本周',
  later: '稍后',
};

export function CVODecisionQueue({ items }: CVODecisionQueueProps) {
  return (
    <section className="rounded-2xl bg-[var(--console-card-bg)] p-5 shadow-[var(--console-card-shadow)]">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-cafe-muted">CVO Decision Queue</h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-cafe-secondary">暂无待决策事项</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li key={item.id} className="rounded-xl bg-[var(--console-shell-bg)] px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-cafe">{item.question}</p>
                <span className="shrink-0 rounded bg-[var(--console-active-bg)] px-1.5 py-0.5 text-micro font-medium text-cafe">
                  {urgencyLabels[item.urgency]}
                </span>
              </div>
              <p className="mt-1 text-xs text-cafe-secondary">{item.context}</p>
              {item.suggestedOptions && item.suggestedOptions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {item.suggestedOptions.map((option) => (
                    <span
                      key={option}
                      className="rounded bg-[var(--console-card-bg)] px-2 py-0.5 text-xs text-cafe-secondary"
                    >
                      {option}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
