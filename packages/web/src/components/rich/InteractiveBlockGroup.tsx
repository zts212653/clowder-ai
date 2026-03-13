'use client';

import { useCallback, useState } from 'react';
import type { RichInteractiveBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';
import { buildSelectionMessage, InteractiveBlock } from './InteractiveBlock';

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

// ── Pure function (exported for testing) ────────────────────

export function buildGroupMessage(
  blocks: RichInteractiveBlock[],
  selections: Map<string, string[]>,
  customTexts?: Map<string, string>,
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const selected = selections.get(block.id);
    if (!selected || selected.length === 0) continue;
    const ct = customTexts?.get(block.id);
    const msg = buildSelectionMessage(
      block.interactiveType,
      block.options,
      selected,
      block.messageTemplate,
      block.title,
      ct || undefined,
    );
    parts.push(msg);
  }
  return parts.join('\n');
}

// ── Component ───────────────────────────────────────────────

/** Check if a block has a customInput option currently selected */
function needsCustomText(block: RichInteractiveBlock, selectedIds?: string[]): boolean {
  if (!selectedIds || selectedIds.length === 0) return false;
  return block.options.some((o) => o.customInput && selectedIds.includes(o.id));
}

export function InteractiveBlockGroup({ blocks, messageId }: { blocks: RichInteractiveBlock[]; messageId?: string }) {
  const allDisabled = blocks.every((b) => b.disabled);
  const [submitted, setSubmitted] = useState(allDisabled);
  const [selections, setSelections] = useState<Map<string, string[]>>(() => {
    const init = new Map<string, string[]>();
    for (const b of blocks) {
      if (b.selectedIds && b.selectedIds.length > 0) init.set(b.id, b.selectedIds);
    }
    return init;
  });
  const [customTexts, setCustomTexts] = useState<Map<string, string>>(() => new Map());

  const handlePendingChange = useCallback((blockId: string, selectedIds: string[]) => {
    setSelections((prev) => {
      const next = new Map(prev);
      if (selectedIds.length === 0) {
        next.delete(blockId); // P2-1 fix: empty selection removes entry
      } else {
        next.set(blockId, selectedIds);
      }
      return next;
    });
  }, []);

  const handleCustomTextChange = useCallback((blockId: string, text: string) => {
    setCustomTexts((prev) => {
      const next = new Map(prev);
      if (text) {
        next.set(blockId, text);
      } else {
        next.delete(blockId);
      }
      return next;
    });
  }, []);

  const allSelected = blocks.every((b) => {
    const sel = selections.get(b.id);
    if (!sel || sel.length === 0) return false;
    // If a customInput option is selected, require non-empty text
    if (needsCustomText(b, sel) && !customTexts.get(b.id)?.trim()) return false;
    return true;
  });

  const handleGroupSubmit = useCallback(() => {
    if (!allSelected || submitted) return;
    setSubmitted(true);

    // Build and send combined message
    const text = buildGroupMessage(blocks, selections, customTexts);
    dispatchInteractiveSend(text);

    // Persist each block
    if (messageId) {
      for (const block of blocks) {
        const optionIds = selections.get(block.id) ?? [];
        useChatStore.getState().updateRichBlock(messageId, block.id, { disabled: true, selectedIds: optionIds });
        patchBlockState(messageId, block.id, { disabled: true, selectedIds: optionIds }).catch(() => {});
      }
    }
  }, [allSelected, submitted, blocks, selections, customTexts, messageId]);

  return (
    <div className="space-y-3 rounded-2xl border-2 border-dashed border-amber-200 dark:border-amber-800/50 p-3">
      {blocks.map((block) => (
        <InteractiveBlock
          key={block.id}
          block={block}
          messageId={messageId}
          pendingMode={!submitted}
          onPendingChange={(ids) => handlePendingChange(block.id, ids)}
          onCustomTextChange={(text) => handleCustomTextChange(block.id, text)}
          groupDisabled={submitted}
          groupSelectedIds={submitted ? selections.get(block.id) : undefined}
        />
      ))}
      {!submitted && (
        <button
          type="button"
          disabled={!allSelected}
          onClick={handleGroupSubmit}
          className={`w-full py-2.5 rounded-full text-sm font-semibold transition-all flex items-center justify-center gap-2
            ${
              allSelected
                ? 'bg-amber-600 text-white hover:bg-amber-700 cursor-pointer'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-400 cursor-not-allowed'
            }`}
        >
          全部提交
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
              allSelected
                ? 'bg-white/20 text-white'
                : 'bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400'
            }`}
          >
            {selections.size}/{blocks.length}
          </span>
        </button>
      )}
    </div>
  );
}
