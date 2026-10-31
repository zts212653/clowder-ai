'use client';
import type { WorkVideoContext } from '@cat-cafe/shared';
import { useState } from 'react';
import { matchVideoChapters, matchVideoStory } from './video-work-alignment';

type Story = WorkVideoContext['story'][number];

export function VideoStoryAlignment({
  left,
  right,
  onAlign,
  leftChapters = [],
  rightChapters = [],
}: {
  leftChapters?: NonNullable<WorkVideoContext['chapters']>;
  rightChapters?: NonNullable<WorkVideoContext['chapters']>;
  left: Story[];
  right: Story[];
  onAlign: (left: Story, right: Story) => void;
}) {
  const chapterMatches = matchVideoChapters(leftChapters, rightChapters);
  const chapters = chapterMatches.length > 0;
  const matches = chapters ? chapterMatches : matchVideoStory(left, right);
  const [selected, setSelected] = useState('');
  const pair = matches.find((row) => row.sourceId === selected);
  if (!matches.length) return <p className="p-2 text-xs text-cafe-muted">没有已核实的段落映射，不自动同步时间。</p>;
  return (
    <div className="space-y-2 p-2 text-xs">
      <label className="block">
        {chapters ? '同一章' : '同一故事段'}
        <select
          aria-label={chapters ? '对齐章节' : '对齐故事段'}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="mt-1 w-full rounded-md border border-cafe-subtle bg-cafe-surface p-1"
        >
          <option value="">{chapters ? '选择章节' : '选择段落'}</option>
          {matches.map((row) => (
            <option key={row.sourceId} value={row.sourceId}>
              {row.right.title}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!pair}
        onClick={() => pair && onAlign(pair.left, pair.right)}
        className="rounded-md border border-cafe-subtle px-2 py-1"
      >
        {chapters ? '两版定位到章首' : '两版定位到这段'}
      </button>
      <p className="text-cafe-muted">按各版独立时间定位开头；时长变化不会被当作同一秒。</p>
    </div>
  );
}
