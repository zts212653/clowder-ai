'use client';

import type { RichChecklistBlock } from '@/stores/chat-types';
import { CafeIcon } from './CafeIcons';

export function ChecklistBlock({ block }: { block: RichChecklistBlock }) {
  const items = Array.isArray(block.items) ? block.items : [];
  return (
    <div className="rounded-lg border border-cafe p-3">
      {block.title && <div className="font-medium text-sm mb-2">{block.title}</div>}
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-sm">
            <CafeIcon
              name={item.checked ? 'check-square' : 'square'}
              className={`mt-0.5 h-4 w-4 shrink-0 ${item.checked ? 'text-cafe-muted' : 'text-cafe-secondary'}`}
            />
            <span className={item.checked ? 'line-through text-cafe-muted' : ''}>{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
