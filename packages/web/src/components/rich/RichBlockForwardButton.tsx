import type { RichBlock } from '@/stores/chat-types';

function richBlockLabel(block: RichBlock): string {
  if ('title' in block && block.title) return block.title;
  if (block.kind === 'file') return block.fileName;
  if (block.kind === 'diff') return block.filePath;
  return '未命名富块';
}

export function RichBlockForwardButton({
  block,
  onForward,
  groupedIndex,
}: {
  block: RichBlock;
  onForward: (blockId: string) => void;
  groupedIndex?: number;
}) {
  return (
    <button
      type="button"
      aria-label={`转发富块：${richBlockLabel(block)}`}
      title="单独转发这个富块"
      onClick={() => onForward(block.id)}
      className={`${groupedIndex === undefined ? 'absolute right-1 top-1 opacity-70 group-hover/rich-block:opacity-100' : ''} inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-cafe bg-cafe-surface/90 px-2 text-sm text-cafe-muted shadow-sm transition hover:bg-cafe-surface-sunken hover:text-cafe-interactive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent`}
    >
      {groupedIndex === undefined ? '转发' : `转发 ${groupedIndex + 1}`}
    </button>
  );
}
