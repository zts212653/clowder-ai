'use client';

import { useMemo, useState } from 'react';
import { memoryGroupPreviewFixture } from '@/components/memory-groups/dev-fixtures';
import { RichBlocks } from '@/components/rich/RichBlocks';

export function MemoryGroupPreview() {
  const [count, setCount] = useState<1 | 4>(4);
  const fixture = useMemo(() => memoryGroupPreviewFixture(count), [count]);
  return (
    <main data-shell="v2" className="min-h-screen bg-cafe-surface-canvas px-4 py-8 text-cafe">
      <div className="mx-auto max-w-2xl space-y-5">
        <header className="space-y-2">
          <h1 className="text-xl font-medium">记忆分组 · 合成预览</h1>
          <p className="text-xs text-cafe-muted">界面验证样例，不写真实记忆。</p>
          <div className="flex gap-2">
            {([1, 4] as const).map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={count === n}
                className="shell-focusable rounded border border-cafe px-3 py-1 text-sm"
                onClick={() => setCount(n)}
              >
                {n} 条
              </button>
            ))}
          </div>
        </header>
        <RichBlocks
          blocks={[fixture.group]}
          publication={{
            threadId: 'group-preview',
            messageId: 'group-message',
            messageRevision: String(fixture.message.timestamp + 1),
          }}
        />
      </div>
    </main>
  );
}
