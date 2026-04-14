'use client';

import { useCallback, useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import type { InteractiveOption, RichInteractiveBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';
import { CafeIcon } from './CafeIcons';
import {
  dispatchGuideStartIfNeeded,
  GUIDE_PREVIEW_CALLBACK_PATH,
  resolveSafeInteractiveCallbackEndpoint,
  shouldKeepGuideOfferInteractive,
} from './guideClientActions';

// ── Pure function (exported for testing) ────────────────────

export function buildSelectionMessage(
  interactiveType: string,
  options: Array<{ id: string; label: string; emoji?: string }>,
  selectedIds: string[],
  messageTemplate?: string,
  title?: string,
  customText?: string,
): string {
  if (interactiveType === 'confirm') {
    const action = selectedIds[0] === '__confirm__' ? '确认' : '取消';
    return title ? `${action} — ${title}` : action;
  }

  const selected = selectedIds.map((id) => options.find((o) => o.id === id)).filter(Boolean) as typeof options;
  const labels = selected.map((o) => (o.emoji ? `${o.emoji} ${o.label}` : o.label));

  // If a customInput option was selected and user typed text, use that text
  if (customText) {
    const base = labels.length > 0 ? `${labels.join(', ')}：${customText}` : customText;
    return title ? `${base}（${title}）` : base;
  }

  if (messageTemplate) {
    return messageTemplate.replace('{selection}', labels.join(', '));
  }

  const base = `我选了：${labels.join(', ')}`;
  return title ? `${base}（${title}）` : base;
}

// ── Helpers ─────────────────────────────────────────────────

function patchBlockState(messageId: string, blockId: string, patch: { disabled?: boolean; selectedIds?: string[] }) {
  return apiFetch(`/api/messages/${messageId}/block-state`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: getUserId(), blockId, ...patch }),
  });
}

function dispatchInteractiveSend(text: string) {
  window.dispatchEvent(new CustomEvent('cat-cafe:interactive-send', { detail: { text } }));
}

/** Render option icon: prefer SVG icon over emoji */
function OptionIcon({ opt, className = 'w-5 h-5' }: { opt: InteractiveOption; className?: string }) {
  if (opt.icon)
    return <CafeIcon name={opt.icon} className={`${className} text-amber-600 dark:text-amber-400 shrink-0`} />;
  if (opt.emoji) return <span className="text-base shrink-0 leading-none">{opt.emoji}</span>;
  return null;
}

// ── Sub-components ──────────────────────────────────────────

function SelectInteraction({
  options,
  disabled,
  selectedIds,
  onSelect,
  hideSubmit,
  onCustomText,
}: {
  options: InteractiveOption[];
  disabled: boolean;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  hideSubmit?: boolean;
  onCustomText?: (text: string) => void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [customText, setCustomText] = useState('');
  const ime = useIMEGuard();
  const highlightId = disabled ? (selectedIds[0] ?? null) : pendingId;
  const pendingOpt = pendingId ? options.find((o) => o.id === pendingId) : null;
  const showCustomInput = !disabled && pendingOpt?.customInput;

  const handleClick = (id: string) => {
    if (disabled) return;
    setPendingId(id);
    setCustomText('');
    // Clear stale customText in parent when switching options
    if (onCustomText) onCustomText('');
    // In group mode, immediately notify parent of pending selection
    if (hideSubmit) onSelect([id]);
  };

  const handleSubmit = () => {
    if (!pendingId) return;
    if (showCustomInput && onCustomText) onCustomText(customText);
    onSelect([pendingId]);
  };

  return (
    <div className="space-y-2">
      {options.map((opt) => {
        const isSelected = highlightId === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => handleClick(opt.id)}
            className={`w-full text-left px-4 py-3 rounded-xl border-[1.5px] text-sm transition-all flex items-center gap-2.5
              ${
                isSelected
                  ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30'
                  : disabled
                    ? 'border-cafe dark:border-gray-700 opacity-50 cursor-not-allowed'
                    : 'border-cafe dark:border-gray-700 hover:border-amber-300 hover:bg-amber-50/50 dark:hover:bg-amber-950/20 cursor-pointer'
              }`}
          >
            <OptionIcon opt={opt} />
            <div className="flex-1 min-w-0">
              <span className={`font-semibold ${isSelected ? 'text-amber-700 dark:text-amber-400' : ''}`}>
                {opt.label}
              </span>
              {opt.description && (
                <span className="block text-xs text-cafe-secondary dark:text-gray-400 mt-0.5">{opt.description}</span>
              )}
            </div>
            {isSelected && (
              <svg
                className="w-5 h-5 text-amber-600 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        );
      })}
      {showCustomInput && (
        <div className="mt-1">
          <input
            type="text"
            value={customText}
            onChange={(e) => {
              setCustomText(e.target.value);
              if (onCustomText) onCustomText(e.target.value);
            }}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !ime.isComposing() && customText.trim()) handleSubmit();
            }}
            placeholder={pendingOpt?.customInputPlaceholder ?? '输入你的想法...'}
            className="w-full px-4 py-2.5 rounded-xl border-[1.5px] border-amber-300 dark:border-amber-700 bg-cafe-surface dark:bg-gray-900 text-sm focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 placeholder:text-gray-400"
          />
        </div>
      )}
      {!disabled && !hideSubmit && pendingId && (
        <button
          type="button"
          disabled={showCustomInput && !customText.trim()}
          onClick={handleSubmit}
          className={`mt-2 w-full py-2.5 rounded-full text-sm font-semibold transition-colors flex items-center justify-center gap-1.5
            ${
              showCustomInput && !customText.trim()
                ? 'bg-gray-200 dark:bg-gray-700 text-cafe-muted cursor-not-allowed'
                : 'bg-amber-600 text-white hover:bg-amber-700'
            }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          确认选择
        </button>
      )}
    </div>
  );
}

function MultiSelectInteraction({
  options,
  disabled,
  selectedIds,
  maxSelect,
  onSelect,
  hideSubmit,
}: {
  options: InteractiveOption[];
  disabled: boolean;
  selectedIds: string[];
  maxSelect?: number;
  onSelect: (ids: string[]) => void;
  hideSubmit?: boolean;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set(selectedIds));

  const toggle = (id: string) => {
    if (disabled) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (!maxSelect || next.size < maxSelect) {
        next.add(id);
      }
      // In group mode, notify parent of every change
      if (hideSubmit) onSelect([...next]);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {options.map((opt) => {
        const isChecked = checked.has(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => toggle(opt.id)}
            className={`flex items-center gap-2.5 w-full px-4 py-3 rounded-xl border-[1.5px] text-sm transition-all text-left
              ${
                isChecked
                  ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30'
                  : 'border-cafe dark:border-gray-700 hover:border-amber-300'
              }
              ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span
              className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center transition-colors ${
                isChecked ? 'bg-amber-600' : 'border-[1.5px] border-cafe dark:border-gray-600'
              }`}
            >
              {isChecked && (
                <svg
                  className="w-3.5 h-3.5 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={3}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </span>
            <OptionIcon opt={opt} />
            <span className={`font-semibold ${isChecked ? 'text-amber-700 dark:text-amber-400' : ''}`}>
              {opt.label}
            </span>
          </button>
        );
      })}
      {!disabled && !hideSubmit && checked.size > 0 && (
        <button
          type="button"
          onClick={() => onSelect([...checked])}
          className="mt-2 w-full py-2.5 bg-amber-600 text-white rounded-full text-sm font-semibold hover:bg-amber-700 transition-colors flex items-center justify-center gap-1.5"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          确认选择 ({checked.size})
        </button>
      )}
    </div>
  );
}

function CardGridInteraction({
  options,
  disabled,
  selectedIds,
  allowRandom,
  onSelect,
  pendingMode,
}: {
  options: InteractiveOption[];
  disabled: boolean;
  selectedIds: string[];
  allowRandom?: boolean;
  onSelect: (ids: string[]) => void;
  pendingMode?: boolean;
}) {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const shuffling = useRef(false);

  const handleCardClick = (id: string) => {
    if (disabled || shuffling.current) return;
    setPendingId(id);
    setHighlightId(null);
    // In group mode, notify parent of pending selection immediately
    if (pendingMode) onSelect([id]);
  };

  const handleSubmit = () => {
    if (!pendingId) return;
    onSelect([pendingId]);
  };

  const handleRandom = useCallback(() => {
    if (disabled || shuffling.current || options.length === 0) return;
    shuffling.current = true;

    const totalSteps = 12;
    let step = 0;

    const tick = () => {
      const idx = step % options.length;
      setHighlightId(options[idx]?.id);
      step++;
      if (step < totalSteps) {
        const delay = 50 + step * 25;
        setTimeout(tick, delay);
      } else {
        const finalIdx = Math.floor(Math.random() * options.length);
        const finalId = options[finalIdx]?.id;
        setHighlightId(finalId);
        setPendingId(finalId);
        shuffling.current = false;
        // In group mode, notify parent after animation
        if (pendingMode) {
          setTimeout(() => onSelect([finalId]), 400);
        }
      }
    };
    tick();
  }, [disabled, options, onSelect, pendingMode]);

  // Group options by group field
  const groups = new Map<string, InteractiveOption[]>();
  for (const opt of options) {
    const g = opt.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)?.push(opt);
  }

  return (
    <div>
      {[...groups.entries()].map(([groupName, groupOpts]) => (
        <div key={groupName}>
          {groupName && <div className="text-xs text-cafe-secondary mb-1 mt-2 font-medium">{groupName}</div>}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {groupOpts.map((opt) => {
              const isSelected = selectedIds.includes(opt.id);
              const isPending = pendingId === opt.id;
              const isHighlighted = highlightId === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleCardClick(opt.id)}
                  className={`p-4 rounded-2xl border-[1.5px] text-center text-sm transition-all
                    ${
                      isSelected || isPending
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30 ring-2 ring-amber-400/50'
                        : isHighlighted
                          ? 'border-amber-400 bg-amber-50/80 dark:bg-amber-950/20 scale-105'
                          : disabled
                            ? 'border-cafe dark:border-gray-700 opacity-50 cursor-not-allowed'
                            : 'border-cafe dark:border-gray-700 bg-cafe-surface-elevated dark:bg-gray-800/50 hover:border-amber-300 hover:shadow-sm cursor-pointer'
                    }`}
                >
                  {(opt.icon || opt.emoji) && (
                    <div className="mb-1.5 flex justify-center">
                      <OptionIcon opt={opt} className="w-7 h-7" />
                    </div>
                  )}
                  <div
                    className={`font-semibold ${isSelected || isPending ? 'text-amber-700 dark:text-amber-400' : ''}`}
                  >
                    {opt.label}
                  </div>
                  {opt.description && (
                    <div className="text-xs text-cafe-secondary dark:text-gray-400 mt-0.5">{opt.description}</div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {!disabled && (allowRandom || pendingId) && (
        <div className="flex gap-2 mt-2">
          {allowRandom && !disabled && (
            <button
              type="button"
              onClick={handleRandom}
              className="px-4 py-1.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-lg text-sm hover:from-amber-600 hover:to-orange-600 transition-all"
            >
              <CafeIcon name="shuffle" className="w-4 h-4 inline-block" /> 随机抽
            </button>
          )}
          {!disabled && !pendingMode && pendingId && (
            <button
              type="button"
              onClick={handleSubmit}
              className="flex-1 py-2.5 bg-amber-600 text-white rounded-full text-sm font-semibold hover:bg-amber-700 transition-colors flex items-center justify-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              确认选择
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmInteraction({
  options,
  disabled,
  selectedIds,
  onSelect,
  pendingMode,
}: {
  options: InteractiveOption[];
  disabled: boolean;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  pendingMode?: boolean;
}) {
  const confirmOpt = options.find((o) => o.id === '__confirm__') ?? { id: '__confirm__', label: '确认' };
  const cancelOpt = options.find((o) => o.id === '__cancel__') ?? { id: '__cancel__', label: '取消' };
  const [pendingId, setPendingId] = useState<string | null>(null);
  const selectedId = disabled ? selectedIds[0] : pendingMode ? pendingId : selectedIds[0];

  const handleClick = (id: string) => {
    if (disabled) return;
    if (pendingMode) {
      setPendingId(id);
      onSelect([id]);
    } else {
      onSelect([id]);
    }
  };

  return (
    <div className="flex gap-3">
      <button
        type="button"
        disabled={disabled}
        onClick={() => handleClick('__cancel__')}
        className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border-[1.5px] flex items-center justify-center gap-1.5
          ${
            selectedId === '__cancel__'
              ? 'bg-red-50 dark:bg-red-950/30 border-red-400 text-red-600 dark:text-red-400'
              : disabled && selectedId
                ? 'bg-cafe-surface-elevated dark:bg-gray-800 border-cafe dark:border-gray-700 text-cafe-muted opacity-50 cursor-not-allowed'
                : disabled
                  ? 'bg-cafe-surface-elevated dark:bg-gray-800 border-cafe dark:border-gray-700 text-cafe-muted cursor-not-allowed'
                  : 'bg-red-50/50 dark:bg-red-950/10 border-red-200 dark:border-red-800 text-red-500 hover:bg-red-50 hover:border-red-300 cursor-pointer'
          }`}
      >
        {selectedId !== '__cancel__' && (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}
        {cancelOpt.label}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => handleClick('__confirm__')}
        className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border-[1.5px] flex items-center justify-center gap-1.5
          ${
            selectedId === '__confirm__'
              ? 'bg-green-50 dark:bg-green-950/30 border-green-500 text-green-600 dark:text-green-400'
              : disabled && selectedId
                ? 'bg-cafe-surface-elevated dark:bg-gray-800 border-cafe dark:border-gray-700 text-cafe-muted opacity-50 cursor-not-allowed'
                : disabled
                  ? 'bg-cafe-surface-elevated dark:bg-gray-800 border-cafe dark:border-gray-700 text-cafe-muted cursor-not-allowed'
                  : 'bg-green-50/50 dark:bg-green-950/10 border-green-200 dark:border-green-800 text-green-600 hover:bg-green-50 hover:border-green-300 cursor-pointer'
          }`}
      >
        {selectedId !== '__confirm__' && (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
        {confirmOpt.label}
      </button>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────

export interface InteractiveBlockProps {
  block: RichInteractiveBlock;
  messageId?: string;
  /** Phase C: pending mode — selections don't auto-submit, parent handles it */
  pendingMode?: boolean;
  /** Phase C: called when pending selection changes in group mode */
  onPendingChange?: (selectedIds: string[]) => void;
  /** Phase C: called when customInput text changes in group mode */
  onCustomTextChange?: (text: string) => void;
  /** Phase C: externally controlled disabled (group submitted) */
  groupDisabled?: boolean;
  /** Phase C: externally controlled selectedIds (group submitted) */
  groupSelectedIds?: string[];
}

export function InteractiveBlock({
  block,
  messageId,
  pendingMode,
  onPendingChange,
  onCustomTextChange,
  groupDisabled,
  groupSelectedIds,
}: InteractiveBlockProps) {
  const [localDisabled, setLocalDisabled] = useState(block.disabled ?? false);
  const [localSelectedIds, setLocalSelectedIds] = useState<string[]>(block.selectedIds ?? []);
  const customTextRef = useRef('');
  const isDisabled = groupDisabled ?? localDisabled;
  const displaySelectedIds = groupSelectedIds ?? localSelectedIds;

  const handleCustomText = useCallback(
    (text: string) => {
      customTextRef.current = text;
      if (onCustomTextChange) onCustomTextChange(text);
    },
    [onCustomTextChange],
  );

  const handleSelect = useCallback(
    async (optionIds: string[]) => {
      if (isDisabled) return;

      // Phase C: in pending mode, just notify parent — don't submit or disable
      if (pendingMode && onPendingChange) {
        onPendingChange(optionIds);
        return;
      }

      const selectedOption = block.options.find((o) => optionIds.includes(o.id));
      const shouldDisable = !shouldKeepGuideOfferInteractive(block, selectedOption);
      setLocalSelectedIds(optionIds);
      setLocalDisabled(shouldDisable);

      // F155: Check if the selected option has a direct action (bypasses chat message pipeline)
      if (selectedOption?.action?.type === 'callback') {
        const { endpoint, payload } = selectedOption.action;
        const safeEndpoint = resolveSafeInteractiveCallbackEndpoint(endpoint);
        if (!safeEndpoint) {
          console.error('[InteractiveBlock] callback action blocked by endpoint allowlist:', endpoint);
          setLocalDisabled(false);
          setLocalSelectedIds([]);
          return;
        }
        try {
          const response = await apiFetch(safeEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload ?? {}),
          });
          if (!response.ok) {
            console.error('[InteractiveBlock] callback action rejected:', response.status, safeEndpoint);
            setLocalDisabled(false);
            setLocalSelectedIds([]);
            return;
          }

          // B-5: Trigger guide start via Zustand reducer (no CustomEvent bridge)
          await dispatchGuideStartIfNeeded(safeEndpoint, payload as Record<string, unknown> | undefined);

          // F155: Preview callback self-heals state, then sends chat message
          // so the routing layer (now with awaiting_choice state) triggers the cat
          // to respond with a formatted step list.
          if (safeEndpoint === GUIDE_PREVIEW_CALLBACK_PATH) {
            const text = buildSelectionMessage(
              block.interactiveType,
              block.options,
              optionIds,
              block.messageTemplate,
              block.title,
            );
            dispatchInteractiveSend(text);
          }
        } catch (err) {
          console.error('[InteractiveBlock] callback action failed:', err);
          setLocalDisabled(false);
          setLocalSelectedIds([]);
          return;
        }
      } else {
        // Default: send selection as a chat message
        const ct = customTextRef.current;
        const text = buildSelectionMessage(
          block.interactiveType,
          block.options,
          optionIds,
          block.messageTemplate,
          block.title,
          ct || undefined,
        );
        dispatchInteractiveSend(text);
      }

      // P2-1 fix: write back to store so re-mount/thread-switch preserves state
      if (messageId) {
        useChatStore.getState().updateRichBlock(messageId, block.id, {
          disabled: shouldDisable,
          selectedIds: optionIds,
        });
        // Persist to backend
        patchBlockState(messageId, block.id, { disabled: shouldDisable, selectedIds: optionIds }).catch(() => {
          // Persistence failure is non-critical — local + store state already updated
        });
      }
    },
    [isDisabled, block, messageId, pendingMode, onPendingChange],
  );

  return (
    <div className="rounded-2xl border border-cafe dark:border-gray-700 p-4">
      {block.title && <div className="font-semibold text-sm mb-1">{block.title}</div>}
      {block.description && (
        <div className="text-xs text-cafe-secondary dark:text-gray-400 mb-3">{block.description}</div>
      )}
      {block.interactiveType === 'select' && (
        <SelectInteraction
          options={block.options}
          disabled={isDisabled}
          selectedIds={displaySelectedIds}
          onSelect={handleSelect}
          hideSubmit={pendingMode}
          onCustomText={handleCustomText}
        />
      )}
      {block.interactiveType === 'multi-select' && (
        <MultiSelectInteraction
          options={block.options}
          disabled={isDisabled}
          selectedIds={displaySelectedIds}
          maxSelect={block.maxSelect}
          onSelect={handleSelect}
          hideSubmit={pendingMode}
        />
      )}
      {block.interactiveType === 'card-grid' && (
        <CardGridInteraction
          options={block.options}
          disabled={isDisabled}
          selectedIds={displaySelectedIds}
          allowRandom={block.allowRandom}
          onSelect={handleSelect}
          pendingMode={pendingMode}
        />
      )}
      {block.interactiveType === 'confirm' && (
        <ConfirmInteraction
          options={block.options}
          disabled={isDisabled}
          selectedIds={displaySelectedIds}
          onSelect={handleSelect}
          pendingMode={pendingMode}
        />
      )}
    </div>
  );
}
