import type { CatData } from '@/hooks/useCatData';
import { formatCatName } from '@/hooks/useCatData';
import { HubIcon } from './hub-icons';

interface DefaultCatSelectorProps {
  cats: CatData[];
  currentDefaultCatId: string;
  onSelect: (catId: string) => void;
  isLoading?: boolean;
  fetchError?: boolean;
  saveError?: string | null;
  onRetry?: () => void;
}

export function DefaultCatSelector({
  cats,
  currentDefaultCatId,
  onSelect,
  isLoading,
  fetchError,
  saveError,
  onRetry,
}: DefaultCatSelectorProps) {
  const valueInList = currentDefaultCatId && cats.some((c) => c.id === currentDefaultCatId);

  return (
    <div data-testid="default-cat-selector">
      <div className="flex h-[72px] items-center gap-3 rounded-[14px] bg-[var(--console-card-bg)] px-4 py-3 shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-cafe">全局默认猫</p>
          <p className="mt-1 text-[12px] text-cafe-secondary">新 thread 没有历史时默认由这只猫回复</p>
        </div>

        <div className="relative shrink-0">
          <select
            data-testid="default-cat-select"
            value={valueInList ? currentDefaultCatId : ''}
            disabled={isLoading}
            onChange={(e) => onSelect(e.target.value)}
            className={`h-[34px] w-[220px] appearance-none rounded-lg border border-transparent bg-[var(--console-shell-bg)] pr-8 pl-2.5 text-[12px] text-cafe-secondary focus:outline-none focus:ring-2 focus:ring-[var(--cafe-accent)]/25 ${isLoading ? 'cursor-wait opacity-50' : 'cursor-pointer'}`}
          >
            {!valueInList && (
              <option value="" disabled>
                {currentDefaultCatId ? '当前默认猫不可用' : '请选择默认猫'}
              </option>
            )}
            {cats.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {formatCatName(cat)}
                {cat.nickname ? ` (${cat.nickname})` : ''}
              </option>
            ))}
          </select>
          <HubIcon
            name="chevron-down"
            className="pointer-events-none absolute top-[10px] right-2.5 h-3.5 w-3.5 text-cafe-muted"
          />
        </div>
      </div>

      {fetchError && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-conn-amber-bg px-3 py-2 text-xs text-conn-amber-text">
          <span>加载失败，当前默认猫未知</span>
          {onRetry && (
            <button
              type="button"
              data-testid="retry-fetch"
              onClick={onRetry}
              className="font-medium text-conn-amber-text underline hover:opacity-90"
            >
              重试
            </button>
          )}
        </div>
      )}
      {saveError && (
        <div className="mt-2 rounded-lg bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">{saveError}</div>
      )}
    </div>
  );
}
