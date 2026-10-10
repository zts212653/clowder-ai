import type { CatData } from '@/hooks/useCatData';
import { formatCatName } from '@/hooks/useCatData';
import { catColorVar } from '@/lib/cat-slug';

interface DefaultCatSelectorProps {
  cats: CatData[];
  currentDefaultCatId: string;
  onSelect: (catId: string) => void;
  isLoading?: boolean;
  /** P1-2: Show error state when GET /api/config/default-cat fails */
  fetchError?: boolean;
  /** P2-1: Show error message when PUT fails */
  saveError?: string | null;
  /** P1-2: Retry fetching default cat */
  onRetry?: () => void;
}

/**
 * F154 Phase B (AC-B2): Dropdown for choosing the global default responder cat.
 * clowder-ai#543: Migrated from card grid to dropdown for scalability.
 */
export function DefaultCatSelector({
  cats,
  currentDefaultCatId,
  onSelect,
  isLoading,
  fetchError,
  saveError,
  onRetry,
}: DefaultCatSelectorProps) {
  const labelId = useId();
  const currentCat = cats.find((c) => c.id === currentDefaultCatId);
  const valueInList = currentDefaultCatId && cats.some((c) => c.id === currentDefaultCatId);

  return (
    <div className="rounded-xl bg-[var(--console-card-bg)] p-4 shadow-[var(--shadow-elevation-2)]">
      {fetchError && (
        <div className="flex items-center gap-2 mb-3 text-xs text-semantic-warning bg-semantic-warning-surface rounded-lg px-3 py-2">
          <span>加载失败，当前默认猫未知</span>
          {onRetry && (
            <button
              type="button"
              data-testid="retry-fetch"
              onClick={onRetry}
              className="text-semantic-warning font-medium underline hover:text-semantic-warning"
            >
              重试
            </button>
          )}
        </div>
      )}
      {saveError && (
        <div className="mb-3 text-xs text-semantic-critical bg-semantic-critical-surface rounded-lg px-3 py-2">
          {saveError}
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <h3 id={labelId} className="text-sm font-bold text-cafe-black">
            默认回复伙伴
          </h3>
          <p className="text-xs text-cafe-muted mt-0.5">新对话未指定伙伴时，由这位伙伴回复</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {currentCat && (
            <span
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: catColorVar(currentCat.id, 'primary') }}
              data-testid="selected-color-dot"
            />
          )}
          <select
            data-testid="default-cat-select"
            aria-labelledby={labelId}
            value={valueInList ? currentDefaultCatId : ''}
            disabled={isLoading}
            onChange={(e) => onSelect(e.target.value)}
            className={`min-h-11 w-full sm:w-[220px] rounded-[10px] border-transparent bg-[var(--console-field-bg)] px-3 py-1 text-compact text-cafe
              focus:outline-none focus:ring-1 focus:ring-[var(--console-input-stroke)]
              ${isLoading ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
          >
            {!valueInList && (
              <option value="" disabled>
                {currentDefaultCatId ? '当前默认猫不可用' : '请选择默认猫'}
              </option>
            )}
            {cats.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {formatCatName(cat)}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

import { useId } from 'react';
