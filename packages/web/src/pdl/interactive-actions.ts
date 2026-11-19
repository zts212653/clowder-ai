import type { RichInteractiveBlock } from '@cat-cafe/shared';
import {
  dispatchGuideStartIfNeeded,
  GUIDE_PREVIEW_CALLBACK_PATH,
  resolveSafeInteractiveCallbackEndpoint,
  shouldKeepGuideOfferInteractive,
} from '@/components/rich/guideClientActions';
import { buildGroupMessage, buildSelectionMessage } from '@/components/rich/interactive-message';
import { apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';

type SubmittedPatches = { blockId: string; disabled: boolean; selectedIds: string[] }[];

/** Keep ordinary interactive choices on their existing callback/chat and block-state owners. */
export async function submitInteractiveSelection(
  messageId: string,
  block: RichInteractiveBlock,
  selectedIds: string[],
  customInput: string | undefined,
  send: (text: string) => Promise<boolean | void>,
  onSubmitted?: (patches: SubmittedPatches) => void,
) {
  validateSelection(block, selectedIds, customInput);
  const options = block.options.filter((o) => selectedIds.includes(o.id));
  const callback = options.find((o) => o.action)?.action;
  if (callback && options.length !== 1) throw new Error('回调选项需要单独提交');
  const text = buildSelectionMessage(
    block.interactiveType,
    block.options,
    selectedIds,
    block.messageTemplate,
    block.title,
    customInput,
  );
  if (callback) {
    const endpoint = resolveSafeInteractiveCallbackEndpoint(callback.endpoint);
    if (!endpoint) throw new Error('不允许的回调地址');
    const response = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callback.payload ?? {}),
    });
    if (!response.ok) throw new Error('选项回调未成功');
    await dispatchGuideStartIfNeeded(endpoint, callback.payload);
    if (endpoint === GUIDE_PREVIEW_CALLBACK_PATH && (await send(text)) === false) throw new Error('选择未发送');
  } else if ((await send(text)) === false) throw new Error('选择未发送');
  onSubmitted?.([{ blockId: block.id, ...selectionPatch(block, selectedIds) }]);
  return persistSelection(messageId, block, selectedIds);
}

function validateSelection(block: RichInteractiveBlock, selectedIds: string[], customInput?: string) {
  if (
    block.disabled ||
    !selectedIds.length ||
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some((id) => !block.options.some((o) => o.id === id)) ||
    (block.interactiveType !== 'multi-select' && selectedIds.length !== 1) ||
    (block.maxSelect !== undefined && selectedIds.length > block.maxSelect)
  )
    throw new Error('请选择有效选项');
  if (block.options.some((o) => o.customInput && selectedIds.includes(o.id)) && !customInput?.trim())
    throw new Error('请填写补充回答');
}

function selectionPatch(block: RichInteractiveBlock, selectedIds: string[]) {
  const selected = block.options.find((o) => selectedIds.includes(o.id));
  return { selectedIds, disabled: !shouldKeepGuideOfferInteractive(block, selected) };
}
async function persistSelection(messageId: string, block: RichInteractiveBlock, selectedIds: string[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await apiFetch(`/api/messages/${encodeURIComponent(messageId)}/block-state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: getUserId(), blockId: block.id, ...selectionPatch(block, selectedIds) }),
    }).catch(() => null);
    if (response?.ok) return true;
    if (response && response.status < 500) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  return false;
}

export async function submitInteractiveGroup(
  messageId: string,
  picks: { block: RichInteractiveBlock; selectedIds: string[]; customInput?: string }[],
  send: (text: string) => Promise<boolean | void>,
  onSubmitted?: (patches: SubmittedPatches) => void,
) {
  for (const p of picks) validateSelection(p.block, p.selectedIds, p.customInput);
  if (picks.length === 1) {
    const p = picks[0];
    return submitInteractiveSelection(messageId, p.block, p.selectedIds, p.customInput, send, onSubmitted);
  }
  const text = buildGroupMessage(
    picks.map((p) => p.block),
    new Map(picks.map((p) => [p.block.id, p.selectedIds])),
    new Map(picks.map((p) => [p.block.id, p.customInput ?? ''])),
  );
  if ((await send(text)) === false) throw new Error('选择未发送');
  onSubmitted?.(picks.map((p) => ({ blockId: p.block.id, ...selectionPatch(p.block, p.selectedIds) })));
  let saved = true;
  for (const p of picks) if (!(await persistSelection(messageId, p.block, p.selectedIds))) saved = false;
  return saved;
}
