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
      className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-cafe-muted transition-[background-color,color,transform] duration-150 hover:bg-cafe-surface-elevated hover:text-cafe-interactive active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
    >
      <svg aria-hidden="true" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <circle cx="6" cy="12" r="2" strokeWidth={1.8} />
        <circle cx="18" cy="6" r="2" strokeWidth={1.8} />
        <circle cx="18" cy="18" r="2" strokeWidth={1.8} />
        <path d="M8 12h2c3.5 0 4-6 6-6M10 12c3.5 0 4 6 6 6" strokeLinecap="round" strokeWidth={1.8} />
      </svg>
      {groupedIndex !== undefined ? (
        <span
          aria-hidden="true"
          className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-cafe-accent px-1 text-micro font-semibold leading-none text-[var(--cafe-surface)]"
        >
          {groupedIndex + 1}
        </span>
      ) : null}
    </button>
  );
}
