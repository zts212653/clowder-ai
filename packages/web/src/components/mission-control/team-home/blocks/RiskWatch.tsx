import type { TeamHomeData } from '../types';

interface RiskWatchProps {
  risks: TeamHomeData['risks'];
}

const severityDot: Record<TeamHomeData['risks'][number]['severity'], string> = {
  high: 'bg-[var(--semantic-danger)]',
  medium: 'bg-[var(--semantic-warning)]',
  low: 'bg-cafe-muted',
};

const riskIcon: Record<TeamHomeData['risks'][number]['type'], string> = {
  vision_drift: '⚠',
  no_evidence: '📛',
  cross_thread_block: '🔒',
  unresolved_review: '👀',
};

export function RiskWatch({ risks }: RiskWatchProps) {
  return (
    <section className="rounded-2xl bg-[var(--console-card-bg)] p-5 shadow-[var(--console-card-shadow)]">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-cafe-muted">Risk Watch</h2>
      {risks.length === 0 ? (
        <p className="mt-3 text-sm text-cafe-secondary">当前无风险告警</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {risks.map((risk) => (
            <li key={risk.id} className="flex items-start gap-2.5 rounded-xl bg-[var(--console-shell-bg)] px-3 py-2.5">
              <span className="text-base">{riskIcon[risk.type]}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${severityDot[risk.severity]}`} />
                  <span className="text-sm text-cafe">{risk.message}</span>
                </div>
                {risk.relatedFeatureId && (
                  <p className="mt-0.5 text-xs text-cafe-secondary">关联：{risk.relatedFeatureId}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
