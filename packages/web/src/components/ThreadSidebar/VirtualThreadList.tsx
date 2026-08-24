import {
  forwardRef,
  type ReactNode,
  type RefObject,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';

export const VIRTUAL_THREAD_LIST_THRESHOLD = 50;
const ROW_HEIGHT_PX = 80;
const OVERSCAN_ROWS = 5;
const FALLBACK_VIEWPORT_HEIGHT_PX = 640;

export interface VirtualThreadListHandle {
  scrollToIndex(index: number): void;
}

interface VirtualThreadListProps {
  threads: SidebarSnapshotRow[];
  scrollContainerRef: RefObject<HTMLDivElement>;
  renderItem: (thread: SidebarSnapshotRow) => ReactNode;
}

function offsetTopWithin(element: HTMLElement, container: HTMLElement): number {
  let top = 0;
  let current: HTMLElement | null = element;
  while (current && current !== container) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return top;
}

export const VirtualThreadList = forwardRef<VirtualThreadListHandle, VirtualThreadListProps>(function VirtualThreadList(
  { threads, scrollContainerRef, renderItem },
  ref,
) {
  const listRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState(() => ({
    start: 0,
    end: Math.min(threads.length, Math.ceil(FALLBACK_VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX) + OVERSCAN_ROWS),
  }));

  const updateRange = useCallback(() => {
    const container = scrollContainerRef.current;
    const list = listRef.current;
    if (!container || !list) return;
    const listTop = offsetTopWithin(list, container);
    const relativeScrollTop = Math.max(0, container.scrollTop - listTop);
    const viewportHeight = container.clientHeight || FALLBACK_VIEWPORT_HEIGHT_PX;
    const start = Math.max(0, Math.floor(relativeScrollTop / ROW_HEIGHT_PX) - OVERSCAN_ROWS);
    const end = Math.min(
      threads.length,
      Math.ceil((relativeScrollTop + viewportHeight) / ROW_HEIGHT_PX) + OVERSCAN_ROWS,
    );
    setRange((current) => (current.start === start && current.end === end ? current : { start, end }));
  }, [scrollContainerRef, threads.length]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    updateRange();
    container.addEventListener('scroll', updateRange, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateRange);
    observer?.observe(container);
    window.addEventListener('resize', updateRange);
    return () => {
      container.removeEventListener('scroll', updateRange);
      observer?.disconnect();
      window.removeEventListener('resize', updateRange);
    };
  }, [scrollContainerRef, updateRange]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index: number) {
        const container = scrollContainerRef.current;
        const list = listRef.current;
        if (!container || !list || index < 0 || index >= threads.length) return;
        const viewportHeight = container.clientHeight || FALLBACK_VIEWPORT_HEIGHT_PX;
        container.scrollTop = Math.max(
          0,
          offsetTopWithin(list, container) + index * ROW_HEIGHT_PX - viewportHeight / 2 + ROW_HEIGHT_PX / 2,
        );
        updateRange();
      },
    }),
    [scrollContainerRef, threads.length, updateRange],
  );

  const visibleThreads = threads.slice(range.start, range.end);

  return (
    <div
      ref={listRef}
      className="relative"
      style={{ height: threads.length * ROW_HEIGHT_PX }}
      data-testid="virtual-thread-list"
      data-rendered-count={visibleThreads.length}
    >
      {visibleThreads.map((thread, offset) => {
        const index = range.start + offset;
        return (
          <div
            key={thread.id}
            className="absolute inset-x-0"
            style={{ top: index * ROW_HEIGHT_PX, height: ROW_HEIGHT_PX }}
          >
            {renderItem(thread)}
          </div>
        );
      })}
    </div>
  );
});
