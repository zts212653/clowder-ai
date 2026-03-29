import type { SignalArticleStats } from '@/utils/signals-api';

interface SignalStatsCardsProps {
  readonly stats: SignalArticleStats | null;
}

interface StatCardProps {
  readonly label: string;
  readonly value: number;
}

function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="rounded-xl border border-cocreator-light bg-cafe-surface px-4 py-3 shadow-sm">
      <p className="text-xs font-medium text-cafe-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-cafe-black">{value}</p>
    </div>
  );
}

export function SignalStatsCards({ stats }: SignalStatsCardsProps) {
  const todayCount = stats?.todayCount ?? 0;
  const unreadCount = stats?.unreadCount ?? 0;
  const weekCount = stats?.weekCount ?? 0;

  return (
    <section aria-label="Signal statistics" className="grid gap-3 sm:grid-cols-3">
      <StatCard label="今日新信号" value={todayCount} />
      <StatCard label="未读" value={unreadCount} />
      <StatCard label="近 7 天" value={weekCount} />
    </section>
  );
}
