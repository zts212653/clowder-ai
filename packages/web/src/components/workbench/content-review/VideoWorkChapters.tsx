import type { WorkVideoContext } from '@cat-cafe/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { type StoryClock, storyTime } from './VideoWorkStory';
import styles from './video-work-chapters.module.css';

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
  const navigation = useRef<HTMLElement>(null);
  const tooltipId = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    const root = navigation.current;
    if (!root || !chapters.length) return;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-chapter-segment]')) {
        const label = button.querySelector<HTMLElement>('[data-chapter-label]');
        button.dataset.labelFits = String(Boolean(label && label.scrollWidth + 12 <= button.clientWidth));
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    measure();
    void document.fonts?.ready.then(measure);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [chapters]);
  if (!chapters.length) return null;
  const current = chapters.filter((chapter) => chapter.startPts <= currentTick).at(-1) ?? chapters[0];
  const inspected = chapters.find((chapter) => chapter.id === (focused ?? hovered));
  const label = (chapter: (typeof chapters)[number]) =>
    `${storyTime(chapter.startPts, clock)} ${chapter.label ?? chapter.title}`;
  const description = (chapter: (typeof chapters)[number]) => `${storyTime(chapter.startPts, clock)} ${chapter.title}`;
  return (
    <nav ref={navigation} aria-label="影片章节" className={styles.navigation}>
      <span className={styles.current} title={description(current)}>
        {label(current)}
      </span>
      <div className={styles.bar}>
        {chapters.map((chapter) => (
          <button
            key={chapter.id}
            type="button"
            data-chapter-segment
            className={styles.segment}
            style={{ flexGrow: chapter.endPts - chapter.startPts }}
            onClick={() => onSeek(chapter)}
            onMouseEnter={() => setHovered(chapter.id)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setFocused(chapter.id)}
            onBlur={() => setFocused(null)}
            aria-label={description(chapter)}
            aria-describedby={inspected?.id === chapter.id ? tooltipId : undefined}
            aria-current={current.id === chapter.id ? 'true' : undefined}
          >
            <span data-chapter-label className={styles.label}>
              {label(chapter)}
            </span>
          </button>
        ))}
      </div>
      {inspected ? (
        <span role="tooltip" id={tooltipId} className={styles.tooltip}>
          {description(inspected)}
        </span>
      ) : null}
    </nav>
  );
}
