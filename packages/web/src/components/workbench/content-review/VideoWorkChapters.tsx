import type { WorkVideoContext } from '@cat-cafe/shared';
import { type StoryClock, storyTime } from './VideoWorkStory';

export function VideoWorkChapters({
  chapters,
  clock,
  currentTick,
  onSeek,
}: {
  chapters: NonNullable<WorkVideoContext['chapters']>;
  clock: StoryClock;
  currentTick: number;
  onSeek: (chapter: NonNullable<WorkVideoContext['chapters']>[number]) => void;
}) {
  if (!chapters.length) return null;
  return (
    <nav aria-label="影片章节" className="flex shrink-0 flex-wrap gap-1 px-3 py-1 text-xs">
      {chapters.map((chapter) => (
        <button
          key={chapter.id}
          type="button"
          onClick={() => onSeek(chapter)}
          aria-current={currentTick >= chapter.startPts && currentTick < chapter.endPts ? 'true' : undefined}
          className="rounded border border-cafe-subtle px-2 py-1 aria-[current=true]:border-cafe-accent"
          title={chapter.title}
        >
          {storyTime(chapter.startPts, clock)} {chapter.label ?? chapter.title}
        </button>
      ))}
    </nav>
  );
}
