import type { CatData } from '@/hooks/useCatData';

/** One control communicates the saved state and the available action. */
export function MemberAvailabilityToggle({
  cat,
  enabled,
  onToggle,
  busy,
}: {
  cat: CatData;
  enabled: boolean;
  onToggle: (cat: CatData) => void;
  busy: boolean;
}) {
  return (
    // Disabled buttons do not run React click handlers; guard descendants before the card sees their clicks.
    <span
      className="inline-flex shrink-0"
      onClickCapture={(event) => {
        if (busy) event.stopPropagation();
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-busy={busy}
        aria-label={`成员启用状态：${cat.displayName}`}
        title={`${enabled ? '停用成员' : '启用成员'}：${cat.displayName}`}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          onToggle(cat);
        }}
        className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-2 text-xs text-cafe-secondary transition-colors hover:bg-[var(--console-hover-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cafe-accent disabled:cursor-wait"
      >
        <span aria-hidden="true">{busy ? '保存中…' : enabled ? '已启用' : '已停用'}</span>
        <span
          aria-hidden="true"
          className={`relative h-[22px] w-10 rounded-full transition-colors ${enabled ? 'bg-cafe-accent' : 'bg-[var(--console-border-soft)]'} ${busy ? 'opacity-50' : ''}`}
        >
          <span
            className={`absolute top-[3px] h-4 w-4 rounded-full bg-[var(--console-card-bg)] transition-[left] ${enabled ? 'left-[21px]' : 'left-[3px]'}`}
          />
        </span>
      </button>
    </span>
  );
}
