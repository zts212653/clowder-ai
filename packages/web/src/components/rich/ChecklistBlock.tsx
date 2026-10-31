'use client';

import { RichChecklist } from '@cat-cafe/ui';
import type { RichChecklistBlock } from '@/stores/chat-types';
import { CafeIcon } from './CafeIcons';

export function ChecklistBlock({ block }: { block: RichChecklistBlock }) {
  return (
    <RichChecklist
      title={block.title}
      items={Array.isArray(block.items) ? block.items : []}
      renderCheck={(checked) => (
        <CafeIcon
          name={checked ? 'check-square' : 'square'}
          className={`mt-0.5 h-4 w-4 shrink-0 ${checked ? 'text-cafe-muted' : 'text-cafe-secondary'}`}
        />
      )}
    />
  );
}
