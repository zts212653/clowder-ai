import { useLayoutEffect, useRef, useState } from 'react';
import { LINEAGE_NODE_SIZE, type layoutExplorationLineage } from './exploration-lineage';
import type { ExplorationReading } from './exploration-reading';

type Viewport = ExplorationReading['viewport'];
type Layout = ReturnType<typeof layoutExplorationLineage>;

/** Fit the relation map; semantic node detail keeps screen text readable at every scale. */
export function useLineageCamera(
  layout: Layout,
  selected: string | undefined,
  viewport: Viewport,
  onViewport: (view: Viewport) => void,
) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const latest = useRef({ layout, selected, viewport, onViewport });
  latest.current = { layout, selected, viewport, onViewport };
  // biome-ignore lint/correctness/useExhaustiveDependencies: only selection/geometry changes reframe; current callbacks and camera live in the ref so dragging does not recenter itself.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const frame = () => {
      const { layout: map, selected: key, viewport: view, onViewport: update } = latest.current;
      const { clientWidth: width, clientHeight: height } = element;
      if (!width || !height) return;
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
      const scale = Math.max(0.001, Math.min(1, width / map.width, height / map.height));
      let next = view;
      if (view.framing !== 'manual') {
        next = { ...view, zoom: scale, x: (width - map.width * scale) / 2, y: (height - map.height * scale) / 2 };
      } else {
        const bounded = { ...view, zoom: Math.max(view.zoom, scale * 0.8) };
        next = bounded;
        const target = map.nodes.find((node) => node.key === key);
        if (
          target &&
          (bounded.zoom !== view.zoom ||
            target.x * bounded.zoom + view.x < 0 ||
            (target.x + LINEAGE_NODE_SIZE.width) * bounded.zoom + view.x > width ||
            target.y * bounded.zoom + view.y < 0 ||
            (target.y + LINEAGE_NODE_SIZE.height) * bounded.zoom + view.y > height)
        ) {
          next = {
            ...bounded,
            x: width / 2 - (target.x + LINEAGE_NODE_SIZE.width / 2) * bounded.zoom,
            y: height / 2 - (target.y + LINEAGE_NODE_SIZE.height / 2) * bounded.zoom,
          };
        }
      }
      if (next.x !== view.x || next.y !== view.y || next.zoom !== view.zoom) update(next);
    };
    frame();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(frame);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected, layout.width, layout.height]);
  return { host, size };
}
