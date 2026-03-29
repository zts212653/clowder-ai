'use client';

import type { RichChecklistBlock } from '@/stores/chat-types';

export function ChecklistBlock({ block }: { block: RichChecklistBlock }) {
  const items = Array.isArray(block.items) ? block.items : [];
  return (
    <div className="rounded-lg border border-cafe dark:border-gray-700 p-3">
      {block.title && <div className="font-medium text-sm mb-2">{block.title}</div>}
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 text-base leading-none">{item.checked ? '☑' : '☐'}</span>
            <span className={item.checked ? 'line-through text-cafe-muted' : ''}>{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
