'use client';
import type { WorkContextRecord, WorkVideoContext } from '@cat-cafe/shared';
import { useState } from 'react';

type Story = WorkVideoContext['story'][number];
export type StoryClock = { timebase: { numerator: number; denominator: number }; startTick: number };
export function storyTime(tick: number, clock?: StoryClock) {
  if (!clock) return null;
  const seconds = Math.max(0, Math.floor((tick * clock.timebase.numerator) / clock.timebase.denominator));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function VideoWorkStory({
  record,
  clock,
  currentTick,
  onSeek,
  onAnnotate,
}: {
  record: WorkContextRecord | null;
  clock?: StoryClock;
  currentTick?: number;
  onSeek: (row: Story, revision: number) => void;
  onAnnotate?: (row: Story, revision: number) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!record?.context.story.length && !record?.context.chapters?.length)
    return <p className="text-xs leading-5 text-cafe-muted">这版没有可用故事线，可以直接看片和标意见。</p>;
  const chapters = record.context.chapters ?? [];
  // Hold the preceding chapter across a silent interlude; never jump back to the opening after the last chapter.
  const active = chapters.filter((row) => row.startPts <= (currentTick ?? 0)).at(-1) ?? chapters[0];
  const lines = (rows: Story[]) => (
    <ol className="space-y-1">
      {rows.map((row) => (
        <li key={row.id} className="group rounded-lg border border-cafe-subtle p-2 text-xs" data-story-id={row.id}>
          <button
            type="button"
            className="w-full text-left"
            aria-current={selected === row.id ? 'true' : undefined}
            onClick={() => {
              setSelected(row.id);
              onSeek(row, record.metadataRevision);
            }}
          >
            {clock ? <time className="mr-2 text-cafe-muted">{storyTime(row.startPts, clock)}</time> : null}
            {!row.chapterId ? <strong>{row.title}</strong> : null}
            <span className="block whitespace-pre-wrap leading-5">{row.text || (row.chapterId ? row.title : '')}</span>
            {row.derived ? <span className="text-cafe-muted">由来源记录整理</span> : null}
          </button>
          {onAnnotate ? (
            <button
              type="button"
              className={`mt-1 text-cafe-accent ${selected === row.id ? '' : 'invisible group-hover:visible group-focus-within:visible'}`}
              onClick={() => onAnnotate(row, record.metadataRevision)}
            >
              对这段提意见
            </button>
          ) : null}
        </li>
      ))}
    </ol>
  );
  return chapters.length ? (
    <ol className="space-y-3">
      {chapters.map((chapter) => (
        <li key={chapter.id} data-chapter-id={chapter.id}>
          <button
            type="button"
            aria-expanded={chapter.id === active?.id}
            className="mb-2 w-full text-left text-xs font-semibold"
            onClick={() => onSeek(chapter, record.metadataRevision)}
          >
            <time className="mr-2 text-cafe-muted">{storyTime(chapter.startPts, clock)}</time>
            {chapter.label ? `${chapter.label} · ` : ''}
            {chapter.title}
          </button>
          {chapter.id === active?.id ? lines(record.context.story.filter((row) => row.chapterId === chapter.id)) : null}
        </li>
      ))}
      {record.context.story.some((row) => !row.chapterId) ? (
        <li>{lines(record.context.story.filter((row) => !row.chapterId))}</li>
      ) : null}
    </ol>
  ) : (
    lines(record.context.story)
  );
}
