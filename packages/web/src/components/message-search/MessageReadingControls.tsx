import { useChatStore } from '@/stores/chatStore';
import { useShellPresentation } from '../shell/shell-presentation';
import type { MessageReadingTrip } from './message-reading-trip';
import type { MessageSearchHost } from './useMessageSearchHost';

const controlClass =
  'rounded-lg px-2 py-1 text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)] disabled:opacity-40';
const statusText: Record<MessageReadingTrip['status'], string> = {
  ready: '仅计本次返回的结果',
  moving: '仅计本次返回的结果',
  completed: '已返回',
  unavailable: '来源或原阅读位置暂不可用，可重试返回。',
  interrupted: '定位已中断，返回点仍保留。',
};

function progressLabel(trip: MessageReadingTrip): string {
  if (trip.status === 'moving') return '定位中…';
  return trip.settledIndex === null
    ? `尚未定位 / ${trip.targets.length}`
    : `${trip.settledIndex + 1} / ${trip.targets.length}`;
}

export function MessageReadingControls({ host }: { host: MessageSearchHost }) {
  const trip = host.session?.trip;
  const journey6 = useShellPresentation() === 'v2';
  const originTitle = useChatStore(
    (state) => state.threads.find((thread) => thread.id === trip?.origin.threadId)?.title,
  );
  if (!trip || trip.status === 'completed') return null;
  const index = trip.pending?.kind === 'target' ? trip.pending.index : (trip.settledIndex ?? -1);
  return (
    <nav
      aria-label="浏览本次检索结果"
      className="ml-auto w-fit rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-2 shadow-[var(--console-shadow-soft)]"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        const next = index + (event.key === 'ArrowUp' ? -1 : 1);
        if (next < 0 || next >= trip.targets.length) return;
        event.preventDefault();
        host.moveTo(next);
      }}
    >
      <div className="flex items-center gap-1">
        <output className="px-2 text-xs text-cafe-secondary" aria-live="polite">
          {progressLabel(trip)}
        </output>
        <button
          type="button"
          className={controlClass}
          aria-label="上一处结果"
          disabled={index <= 0}
          onClick={() => host.moveTo(index - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          className={controlClass}
          aria-label="下一处结果"
          disabled={index + 1 >= trip.targets.length}
          onClick={() => host.moveTo(index + 1)}
        >
          ↓
        </button>
        <button type="button" className={`${controlClass} max-w-52 truncate`} onClick={host.returnToOrigin}>
          {journey6 ? `‹ 回到「${originTitle || '刚才那条对话'}」` : '回到刚才'}
        </button>
      </div>
      <p className="mt-1 px-2 text-micro text-cafe-secondary">{statusText[trip.status]}</p>
      {!host.persisted && (
        <p className="mt-1 px-2 text-micro text-cafe-secondary">恢复记录保存失败，当前页面仍可返回。</p>
      )}
    </nav>
  );
}
