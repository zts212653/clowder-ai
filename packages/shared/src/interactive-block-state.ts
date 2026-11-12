import type { RichBlock } from './types/rich.js';

/** Replayed provider blocks keep their presentation; the compatible saved answer survives. */
export function preserveInteractiveBlockStates(
  blocks: readonly RichBlock[],
  saved: readonly RichBlock[],
  { preferSavedSelection = false } = {},
): RichBlock[] {
  return blocks.map((block) => {
    if (block.kind !== 'interactive') return block;
    const previous = saved.find((candidate) => candidate.id === block.id);
    if (previous?.kind !== 'interactive' || previous.interactiveType !== block.interactiveType) return block;
    const optionIds = new Set(block.options.map((option) => option.id));
    if (previous.options.length !== optionIds.size || previous.options.some((option) => !optionIds.has(option.id))) {
      return block;
    }
    const selections = preferSavedSelection
      ? [previous.selectedIds, block.selectedIds]
      : [block.selectedIds, previous.selectedIds];
    const selectedIds = selections.find((ids) => ids?.length);
    return {
      ...block,
      ...(previous.disabled === true ? { disabled: true } : {}),
      ...(selectedIds?.length ? { selectedIds } : {}),
    };
  });
}
