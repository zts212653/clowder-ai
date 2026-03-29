'use client';

import { DiffViewer } from '@/components/workspace/DiffViewer';
import type { RichDiffBlock } from '@/stores/chat-types';

export function DiffBlock({ block }: { block: RichDiffBlock }) {
  return (
    <div className="rounded-lg border border-gray-700/50 overflow-hidden">
      <div className="bg-[#1E1E24] px-3 py-1.5 text-[11px] font-mono text-cafe-muted border-b border-gray-700/50 truncate">
        {block.filePath}
      </div>
      <DiffViewer diff={block.diff} compact />
    </div>
  );
}
