import type { TeamHomeData } from '../types';

interface CultureConstitutionPanelProps {
  culture: TeamHomeData['culture'];
}

export function CultureConstitutionPanel({ culture }: CultureConstitutionPanelProps) {
  return (
    <section className="rounded-2xl bg-[var(--console-card-bg)] p-5 shadow-[var(--console-card-shadow)]">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-cafe-muted">Culture Constitution</h2>
      <p className="mt-2 text-sm font-medium text-cafe">今日信条：{culture.headline}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {culture.rules.map((rule) => (
          <span
            key={rule.id}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              rule.active
                ? 'bg-[var(--console-active-bg)] text-cafe'
                : 'bg-[var(--console-shell-bg)] text-cafe-secondary'
            }`}
          >
            {rule.text}
          </span>
        ))}
      </div>
      <p className="mt-4 text-xs leading-relaxed text-cafe-secondary">
        我们不是一组被调用的模型。我们是一支有愿景、有边界、有记忆、有复盘、有交付纪律的 Agent 原生开发团队。
      </p>
    </section>
  );
}
