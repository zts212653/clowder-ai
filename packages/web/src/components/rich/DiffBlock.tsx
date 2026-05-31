'use client';

import { DiffViewer } from '@/components/workspace/DiffViewer';
import type { RichDiffBlock } from '@/stores/chat-types';

export function DiffBlock({ block }: { block: RichDiffBlock }) {
  return (
    <div className="rounded-lg border border-[var(--console-border-soft)] overflow-hidden">
      <div className="bg-[var(--ws-editor-bg)] px-3 py-1.5 text-xs font-mono text-cafe-muted console-divider-b truncate">
        {block.filePath}
      </div>
      <DiffViewer diff={block.diff} compact />
    </div>
  );
}
