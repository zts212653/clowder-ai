import type { RefObject } from 'react';
import {
  type TransferCatChoice,
  TransferCatStep,
  type TransferThreadChoice,
  TransferThreadStep,
} from './TransferTargetPickerSteps';

interface TransferTargetPickerViewProps {
  isDesktop: boolean;
  panelRef: RefObject<HTMLDivElement>;
  targetThreadId: string | null;
  targetThreadTitle?: string | null;
  availableThreads: readonly TransferThreadChoice[];
  cats: readonly TransferCatChoice[];
  targetCats: ReadonlySet<string>;
  error: string | null;
  submitting: boolean;
  itemCount: number;
  quoteOnly: boolean;
  onClose: () => void;
  onBack: () => void;
  onSelectThread: (threadId: string) => void;
  onToggleCat: (catId: string) => void;
  onSubmit: () => void;
}

function TransferPickerHeader({
  targetThreadId,
  targetThreadTitle,
  onBack,
  onClose,
}: Pick<TransferTargetPickerViewProps, 'targetThreadId' | 'targetThreadTitle' | 'onBack' | 'onClose'>) {
  return (
    <header className="flex items-center gap-3 border-b border-cafe px-4 py-3">
      {targetThreadId ? (
        <button
          type="button"
          className="rounded-md px-2 py-1 text-sm text-cafe-interactive hover:bg-cafe-surface-sunken"
          onClick={onBack}
        >
          返回
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold text-cafe-primary">转发到</h2>
        <p className="truncate text-xs text-cafe-muted">
          {targetThreadId ? `选择接收猫猫 · ${targetThreadTitle ?? '未命名对话'}` : '先选择一个目标对话'}
        </p>
      </div>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-sm text-cafe-muted hover:bg-cafe-surface-sunken"
        onClick={onClose}
      >
        取消
      </button>
    </header>
  );
}

function TransferPickerBody({
  targetThreadId,
  availableThreads,
  cats,
  targetCats,
  error,
  onSelectThread,
  onToggleCat,
}: Pick<
  TransferTargetPickerViewProps,
  'targetThreadId' | 'availableThreads' | 'cats' | 'targetCats' | 'error' | 'onSelectThread' | 'onToggleCat'
>) {
  return (
    <div className="min-h-0 overflow-y-auto p-3">
      {targetThreadId ? (
        <TransferCatStep cats={cats} selectedCatIds={targetCats} onToggle={onToggleCat} />
      ) : (
        <TransferThreadStep threads={availableThreads} onSelect={onSelectThread} />
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-conn-red-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function TransferPickerFooter({
  targetCats,
  submitting,
  itemCount,
  quoteOnly,
  onSubmit,
}: Pick<TransferTargetPickerViewProps, 'targetCats' | 'submitting' | 'itemCount' | 'quoteOnly' | 'onSubmit'>) {
  return (
    <footer className="flex items-center justify-between gap-3 border-t border-cafe bg-cafe-surface px-4 py-3">
      <span className="text-xs text-cafe-muted">已选 {targetCats.size} 只猫猫</span>
      <button
        type="button"
        disabled={targetCats.size === 0 || submitting}
        className="rounded-lg bg-cafe-accent px-4 py-2 text-sm font-semibold text-[var(--cafe-surface)] hover:bg-cafe-interactive disabled:cursor-not-allowed disabled:opacity-40"
        onClick={onSubmit}
      >
        {submitting ? '转发中…' : quoteOnly ? '转发 1 段引用' : `转发 ${itemCount} 条消息`}
      </button>
    </footer>
  );
}

export function TransferTargetPickerView(props: TransferTargetPickerViewProps) {
  return (
    <div className={`fixed inset-0 z-[90] flex ${props.isDesktop ? 'items-center justify-center p-4' : 'items-end'}`}>
      <button
        type="button"
        className="absolute inset-0 bg-[var(--console-overlay-backdrop)]"
        aria-label="取消转发"
        onClick={props.onClose}
      />
      <div
        ref={props.panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="转发到"
        data-transfer-surface={props.isDesktop ? 'modal' : 'bottom-sheet'}
        className={`relative flex max-h-[min(42rem,90dvh)] w-full flex-col overflow-hidden border border-cafe bg-cafe-surface shadow-2xl ${
          props.isDesktop ? 'max-w-lg rounded-2xl' : 'rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]'
        }`}
      >
        <TransferPickerHeader {...props} />
        <TransferPickerBody {...props} />
        {props.targetThreadId ? <TransferPickerFooter {...props} /> : null}
      </div>
    </div>
  );
}
