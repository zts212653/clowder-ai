import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AttentionListRow } from './attention-clusters';

interface MeasuredRow {
  row: AttentionListRow;
  height: number;
  estimate: number;
}

function sameMeasurement(previous: MeasuredRow | undefined, next: MeasuredRow): boolean {
  return previous?.row === next.row && previous.height === next.height && previous.estimate === next.estimate;
}

/** Optional words never decide the line count. Only the unshrunk presence symbols and badges do. */
export function useSidebarSignalFlow(ref: RefObject<HTMLDivElement>, presence: ReactNode, badges: ReactNode) {
  const [flow, setFlow] = useState({ split: false, presenceMinimum: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: New canonical facts/language replace the measured atoms before paint.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const symbols = [...root.querySelectorAll<HTMLElement>('[data-signal-fixed]')];
    const pills = [...root.querySelectorAll<HTMLElement>('[data-signal-badge]')];
    const minimum = (atoms: HTMLElement[]) =>
      atoms.reduce((width, atom) => width + atom.getBoundingClientRect().width, 0) + Math.max(0, atoms.length - 1) * 4;
    const measure = () => {
      const width = root.getBoundingClientRect().width;
      if (width <= 0) return;
      const presenceMinimum = minimum(symbols);
      const required = presenceMinimum + minimum(pills) + (symbols.length && pills.length ? 4 : 0);
      const split = symbols.length > 0 && pills.length > 0 && required > width;
      setFlow((current) =>
        current.split === split && current.presenceMinimum === presenceMinimum ? current : { split, presenceMinimum },
      );
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const atom of [root, ...symbols, ...pills]) observer?.observe(atom);
    return () => observer?.disconnect();
  }, [ref, presence, badges]);
  return flow;
}

/** Keep intrinsic text measurable while hidden; restoring a word must never resize its allocated slot. */
export function useWholeSidebarSignalText(
  slotRef: RefObject<HTMLSpanElement>,
  contentRef: RefObject<HTMLSpanElement>,
  identity: string,
) {
  const [fits, setFits] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Language/identity changes also require a synchronous measurement.
  useLayoutEffect(() => {
    const slot = slotRef.current,
      content = contentRef.current;
    if (!slot || !content) return;
    const measure = () => {
      const required = content.getBoundingClientRect().width;
      setFits(required > 0 && slot.getBoundingClientRect().width >= required);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(slot);
    observer?.observe(content);
    return () => observer?.disconnect();
  }, [slotRef, contentRef, identity]);
  return fits;
}

/** Layout measurements only. The canonical sidebar projection still owns every conversation fact. */
export function useMeasuredSidebarRows(
  rows: AttentionListRow[],
  listRef: RefObject<HTMLDivElement>,
  containerRef: RefObject<HTMLDivElement>,
  getRowHeight: ((row: AttentionListRow) => number) | undefined,
  range: { start: number; end: number },
) {
  const [measured, setMeasured] = useState<ReadonlyMap<string, MeasuredRow>>(new Map());
  const measuredWidth = useRef<number | null>(null);
  const rowByKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new virtual range mounts different DOM nodes to measure and observe.
  useEffect(() => {
    const list = listRef.current,
      container = containerRef.current;
    if (!getRowHeight || !list || !container) return;
    const measure = () => {
      const resized = measuredWidth.current !== container.clientWidth;
      measuredWidth.current = container.clientWidth;
      const values = [...list.querySelectorAll<HTMLElement>('[data-virtual-row-key]')].flatMap((slot) => {
        const key = slot.dataset.virtualRowKey;
        const row = key ? rowByKey.get(key) : undefined;
        const height = slot.firstElementChild?.getBoundingClientRect().height ?? 0;
        return key && row && height > 0 ? [{ key, row, height: Math.ceil(height), estimate: getRowHeight(row) }] : [];
      });
      setMeasured((current) => {
        if (!resized && values.every((value) => sameMeasurement(current.get(value.key), value))) return current;
        const next = resized ? new Map<string, MeasuredRow>() : new Map(current);
        for (const value of values)
          next.set(value.key, { row: value.row, height: value.height, estimate: value.estimate });
        for (const key of next.keys()) if (!rowByKey.has(key)) next.delete(key);
        return next;
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container);
    for (const slot of list.querySelectorAll('[data-virtual-row-key]'))
      if (slot.firstElementChild) observer?.observe(slot.firstElementChild);
    return () => observer?.disconnect();
  }, [rowByKey, listRef, containerRef, getRowHeight, range.start, range.end]);
  return measured;
}
