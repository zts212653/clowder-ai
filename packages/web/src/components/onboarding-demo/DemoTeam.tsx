import { DEMO_TEAM, type DemoCat } from './demo-story';

export function DemoTeam({ active }: { active?: DemoCat }) {
  return (
    <div className="grid grid-cols-3 gap-2 px-4 py-3 sm:px-6">
      {Object.entries(DEMO_TEAM).map(([id, cat]) => (
        <div
          key={id}
          className={`flex items-center gap-2 rounded-xl border p-2 sm:p-3 ${active === id ? 'border-cafe-accent bg-[var(--console-active-bg)]' : 'border-[var(--console-border-soft)]'}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cat.avatar} alt="" className="hidden h-10 w-10 rounded-full sm:block" />
          <div className="min-w-0">
            <div className="text-sm font-semibold">{cat.name}</div>
            <div className="text-[11px] text-cafe-secondary sm:text-xs">{cat.role}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
