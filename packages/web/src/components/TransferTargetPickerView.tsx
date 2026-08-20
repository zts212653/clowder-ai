import { CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH } from '@cat-cafe/shared';
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
  note: string;
  error: string | null;
  submitting: boolean;
  itemCount: number;
  singleItemLabel?: string;
  onClose: () => void;
  onBack: () => void;
  onSelectThread: (threadId: string) => void;
  onToggleCat: (catId: string) => void;
  onNoteChange: (note: string) => void;
  onSubmit: () => void;
}

function TransferPickerHeader({
  targetThreadId,
  targetThreadTitle,
  onBack,
  onClose,
}: Pick<TransferTargetPickerViewProps, 'targetThreadId' | 'targetThreadTitle' | 'onBack' | 'onClose'>) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-cafe px-4 py-3">
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
  note,
  onSelectThread,
  onToggleCat,
  onNoteChange,
}: Pick<
  TransferTargetPickerViewProps,
  | 'targetThreadId'
  | 'availableThreads'
  | 'cats'
  | 'targetCats'
  | 'note'
  | 'onSelectThread'
  | 'onToggleCat'
  | 'onNoteChange'
>) {
  if (!targetThreadId) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="transfer-picker-thread-scroll">
        <TransferThreadStep threads={availableThreads} onSelect={onSelectThread} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-3">
      <label className="block shrink-0">
        <span className="mb-1.5 block text-xs font-medium text-cafe-muted">转发留言（可选）</span>
        <textarea
          aria-label="转发留言（可选）"
          value={note}
          maxLength={CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH}
          rows={3}
          placeholder="告诉接收方为什么转发这组内容…"
          onChange={(event) => onNoteChange(event.target.value)}
          className="w-full resize-y rounded-xl border border-cafe bg-cafe-surface px-3 py-2.5 text-sm text-cafe-primary outline-none transition-colors placeholder:text-cafe-muted focus:border-cafe-accent focus:ring-2 focus:ring-[var(--cafe-accent-soft)]"
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="transfer-picker-cat-scroll">
        <TransferCatStep cats={cats} selectedCatIds={targetCats} onToggle={onToggleCat} />
      </div>
    </div>
  );
}

function TransferPickerFooter({
  targetCats,
  error,
  submitting,
  itemCount,
  singleItemLabel,
  onSubmit,
}: Pick<
  TransferTargetPickerViewProps,
  'targetCats' | 'error' | 'submitting' | 'itemCount' | 'singleItemLabel' | 'onSubmit'
>) {
  return (
    <footer className="shrink-0 border-t border-cafe bg-cafe-surface px-4 py-3" data-testid="transfer-picker-footer">
      {error ? (
        <p role="alert" className="mb-2 text-sm text-conn-red-text">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-cafe-muted">已选 {targetCats.size} 只猫猫</span>
        <button
          type="button"
          disabled={targetCats.size === 0 || submitting}
          className="rounded-lg bg-cafe-accent px-4 py-2 text-sm font-semibold text-[var(--cafe-surface)] hover:bg-cafe-interactive disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onSubmit}
        >
          {submitting ? '转发中…' : singleItemLabel ? `转发 ${singleItemLabel}` : `转发 ${itemCount} 条消息`}
        </button>
      </div>
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
