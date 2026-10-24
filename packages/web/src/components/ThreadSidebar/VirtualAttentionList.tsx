import {
  forwardRef,
  type ReactNode,
  type RefObject,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AttentionListRow } from './attention-clusters';
import { useMeasuredSidebarRows } from './use-measured-sidebar-rows';
import type { VirtualThreadListHandle } from './VirtualThreadList';

const ROW_HEIGHT_PX = 80;
const OVERSCAN_ROWS = 5;
const FALLBACK_VIEWPORT_HEIGHT_PX = 640;

interface VirtualAttentionListProps {
  rows: AttentionListRow[];
  scrollContainerRef: RefObject<HTMLDivElement>;
  renderItem: (row: AttentionListRow) => ReactNode;
  getRowHeight?: (row: AttentionListRow) => number;
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

function visibleTopInset(container: HTMLElement): number {
  const containerTop = container.getBoundingClientRect().top;
  const occluder = container.querySelector<HTMLElement>('[data-scroll-occluder="true"]');
  if (!occluder) return 0;
  const rect = occluder.getBoundingClientRect();
  return rect.top <= containerTop + 2 && rect.bottom > containerTop ? rect.bottom - containerTop : 0;
}

function viewportHeight(container: HTMLElement): number {
  return container.clientHeight || FALLBACK_VIEWPORT_HEIGHT_PX;
}

export const VirtualAttentionList = forwardRef<VirtualThreadListHandle, VirtualAttentionListProps>(
  function VirtualAttentionList({ rows, scrollContainerRef, renderItem, getRowHeight }, ref) {
    const listRef = useRef<HTMLDivElement>(null);
    const [range, setRange] = useState(() => ({
      start: 0,
      end: Math.min(rows.length, Math.ceil(FALLBACK_VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX) + OVERSCAN_ROWS),
    }));
    const measured = useMeasuredSidebarRows(rows, listRef, scrollContainerRef, getRowHeight, range);
    const offsets = useMemo(() => {
      const result = [0];
      for (const row of rows) {
        const cached = measured.get(row.key);
        const estimate = getRowHeight?.(row) ?? ROW_HEIGHT_PX;
        // HTTP snapshots replace row objects even when their rendered facts are
        // unchanged. Keep the measured estimate for the stable row key until
        // its content is measured again, its estimate changes, or width resets.
        const height = getRowHeight && cached?.estimate === estimate ? cached.height : estimate;
        result.push(result[result.length - 1] + height);
      }
      return result;
    }, [rows, getRowHeight, measured]);
    const previousLayout = useRef<{ offsets: number[]; keys: string[] } | null>(null);
    useLayoutEffect(() => {
      const previous = previousLayout.current;
      previousLayout.current = { offsets, keys: rows.map((row) => row.key) };
      const container = scrollContainerRef.current,
        list = listRef.current;
      if (
        !getRowHeight ||
        !previous ||
        !container ||
        !list ||
        previous.keys.length !== rows.length ||
        !previous.keys.every((key, index) => key === rows[index]?.key)
      )
        return;
      const relativeTop = container.scrollTop - offsetTopWithin(list, container);
      const anchor = previous.keys.findIndex(
        (_, index) => previous.offsets[index] <= relativeTop && previous.offsets[index + 1] > relativeTop,
      );
      if (anchor < 0) return;
      const shift = offsets[anchor] - previous.offsets[anchor];
      if (shift) container.scrollTop += shift;
    }, [offsets, rows, getRowHeight, scrollContainerRef]);
    const indexAt = useCallback(
      (offset: number) => {
        let low = 0;
        let high = rows.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if ((offsets[middle + 1] ?? 0) <= offset) low = middle + 1;
          else high = middle;
        }
        return low;
      },
      [offsets, rows.length],
    );

    const updateRange = useCallback(() => {
      const container = scrollContainerRef.current;
      const list = listRef.current;
      if (!container || !list) return;
      const listTop = offsetTopWithin(list, container);
      const relativeScrollTop = Math.max(0, container.scrollTop - listTop);
      const viewportHeight = container.clientHeight || FALLBACK_VIEWPORT_HEIGHT_PX;
      const start = Math.max(
        0,
        (getRowHeight ? indexAt(relativeScrollTop) : Math.floor(relativeScrollTop / ROW_HEIGHT_PX)) - OVERSCAN_ROWS,
      );
      const end = Math.min(
        rows.length,
        (getRowHeight
          ? indexAt(relativeScrollTop + viewportHeight - 1) + 1
          : Math.ceil((relativeScrollTop + viewportHeight) / ROW_HEIGHT_PX)) + OVERSCAN_ROWS,
      );
      setRange((current) => (current.start === start && current.end === end ? current : { start, end }));
    }, [rows.length, scrollContainerRef, indexAt, getRowHeight]);

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
          if (!container || !list || index < 0 || index >= rows.length) return;
          const height = viewportHeight(container);
          container.scrollTop = Math.max(
            0,
            offsetTopWithin(list, container) + ((offsets[index] ?? 0) + (offsets[index + 1] ?? 0)) / 2 - height / 2,
          );
          updateRange();
        },
        ensureIndexVisible(index: number) {
          const container = scrollContainerRef.current;
          const list = listRef.current;
          if (!container || !list || index < 0 || index >= rows.length) return;
          const height = viewportHeight(container);
          const rowTop = offsetTopWithin(list, container) + (offsets[index] ?? 0);
          const rowBottom = offsetTopWithin(list, container) + (offsets[index + 1] ?? 0);
          const topInset = visibleTopInset(container);
          const visibleTop = container.scrollTop + topInset;
          const visibleBottom = container.scrollTop + height;

          if (rowTop < visibleTop) {
            container.scrollTop = Math.max(0, rowTop - topInset);
            updateRange();
            return;
          }
          if (rowBottom > visibleBottom) container.scrollTop = rowBottom - height;
          updateRange();
        },
      }),
      [rows.length, scrollContainerRef, updateRange, offsets],
    );

    const visibleRows = rows.slice(range.start, range.end);
    return (
      <div
        ref={listRef}
        className="relative"
        style={{ height: offsets[rows.length] }}
        data-testid="virtual-attention-list"
        data-rendered-count={visibleRows.length}
      >
        {visibleRows.map((row, offset) => {
          const index = range.start + offset;
          return (
            <div
              key={row.key}
              data-virtual-row-key={getRowHeight ? row.key : undefined}
              className="absolute inset-x-0"
              style={{ top: offsets[index], height: (offsets[index + 1] ?? 0) - (offsets[index] ?? 0) }}
            >
              {renderItem(row)}
            </div>
          );
        })}
      </div>
    );
  },
);
