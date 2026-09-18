import { formatHandle, formatName } from '../cat-handle';
import type { TeamHomeData } from '../types';

interface TeamStatusCardsProps {
  members: TeamHomeData['team'];
}

const roleEmoji: Record<TeamHomeData['team'][number]['role'], string> = {
  agent: '🐱',
  human: '👤',
};

export function TeamStatusCards({ members }: TeamStatusCardsProps) {
  return (
    <section className="rounded-2xl bg-[var(--console-card-bg)] p-5 shadow-[var(--console-card-shadow)]">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-cafe-muted">Team Status</h2>
      <ul className="mt-3 space-y-2">
        {members.map((member) => (
          <li key={member.id} className="flex items-start gap-3 rounded-xl bg-[var(--console-shell-bg)] px-3 py-2.5">
            <span className="text-lg">{roleEmoji[member.role]}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-cafe">{formatName(member.id)}</span>
                <span className="text-xs text-cafe-muted">{formatHandle(member.id)}</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-cafe-secondary">{member.currentContext}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
