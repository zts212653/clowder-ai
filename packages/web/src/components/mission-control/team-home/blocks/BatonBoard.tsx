import { formatHandleWithName } from '../cat-handle';
import type { TeamHomeData } from '../types';

interface BatonBoardProps {
  baton: TeamHomeData['baton'];
}

export function BatonBoard({ baton }: BatonBoardProps) {
  return (
    <section className="rounded-2xl bg-[var(--console-card-bg)] p-6 shadow-[var(--console-card-shadow)]">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-cafe-muted">Baton Board</h2>
      <div className="mt-3 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--console-active-bg)] text-lg">
          🏀
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-cafe">
            {formatHandleWithName(baton.holder)}
            <span className="mx-2 text-cafe-muted">·</span>
            <span className="text-cafe-secondary">{baton.scope}</span>
          </p>
          <p className="mt-1 text-xs text-cafe-secondary">持球 since {new Date(baton.since).toLocaleString('zh-CN')}</p>
          <div className="mt-3 rounded-xl bg-[var(--console-shell-bg)] px-3 py-2.5">
            <p className="text-xs text-cafe-muted">Next Step</p>
            <p className="mt-0.5 text-sm text-cafe">{baton.nextStep}</p>
          </div>
          {baton.nextOwner && (
            <p className="mt-2 text-xs text-cafe-secondary">下一棒：{formatHandleWithName(baton.nextOwner)}</p>
          )}
          {baton.blocker && (
            <p className="mt-2 text-xs font-medium text-[var(--semantic-danger)]">阻塞：{baton.blocker}</p>
          )}
        </div>
      </div>
    </section>
  );
}
