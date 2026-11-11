import type { RichBlock } from './types/rich.js';

/** Replayed provider blocks keep their presentation; the compatible saved answer survives. */
export function preserveInteractiveBlockStates(blocks: readonly RichBlock[], saved: readonly RichBlock[]): RichBlock[] {
  return blocks.map((block) => {
    if (block.kind !== 'interactive') return block;
    const previous = saved.find((candidate) => candidate.id === block.id);
    if (previous?.kind !== 'interactive' || previous.interactiveType !== block.interactiveType) return block;
    const optionIds = new Set(block.options.map((option) => option.id));
    if (previous.options.length !== optionIds.size || previous.options.some((option) => !optionIds.has(option.id))) {
      return block;
    }
    const selectedIds = block.selectedIds?.length ? block.selectedIds : previous.selectedIds;
    return {
      ...block,
      ...(previous.disabled === true ? { disabled: true } : {}),
      ...(selectedIds?.length ? { selectedIds } : {}),
    };
  });
}
