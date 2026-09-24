import type { TeamHomeData } from '../types';

interface RecentMemoryFeedProps {
  items: TeamHomeData['recentMemory'];
}

const kindLabels: Record<TeamHomeData['recentMemory'][number]['kind'], string> = {
  lesson: 'Lesson',
  adr: 'ADR',
  skill: 'Skill',
  decision: 'Decision',
};

const kindBadge: Record<TeamHomeData['recentMemory'][number]['kind'], string> = {
  lesson: 'bg-[var(--semantic-info-surface)] text-[var(--semantic-info)]',
  adr: 'bg-[var(--semantic-success-surface)] text-[var(--semantic-success)]',
  skill: 'bg-[var(--semantic-warning-surface)] text-[var(--semantic-warning)]',
  decision: 'bg-[var(--console-active-bg)] text-cafe',
};

export function RecentMemoryFeed({ items }: RecentMemoryFeedProps) {
  return (
    <section className="rounded-2xl bg-[var(--console-card-bg)] p-5 shadow-[var(--console-card-shadow)]">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-cafe-muted">Recent Memory</h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-cafe-secondary">最近没有沉淀</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-start justify-between gap-2 rounded-xl bg-[var(--console-shell-bg)] px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <a href={item.anchor} className="text-sm font-medium text-cafe hover:underline">
                  {item.title}
                </a>
                <p className="mt-0.5 text-xs text-cafe-secondary">
                  {new Date(item.createdAt).toLocaleDateString('zh-CN')}
                </p>
              </div>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-micro font-medium ${kindBadge[item.kind]}`}>
                {kindLabels[item.kind]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
