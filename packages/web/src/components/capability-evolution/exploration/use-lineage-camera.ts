import { useLayoutEffect, useRef, useState } from 'react';
import type { layoutExplorationLineage } from './exploration-lineage';
import type { ExplorationReading } from './exploration-reading';
import { fitLineageViewport } from './lineage-viewport';

type Viewport = ExplorationReading['viewport'];
type Layout = ReturnType<typeof layoutExplorationLineage>;
type CameraOptions = {
  minimumZoom: number;
  nodeSize: { width: number; height: number };
};

function selectedNodeIsOutside(
  target: Layout['nodes'][number],
  viewport: Viewport,
  size: { width: number; height: number },
  nodeSize: { width: number; height: number },
) {
  const centerX = (target.x + nodeSize.width / 2) * viewport.zoom + viewport.x;
  const centerY = (target.y + nodeSize.height / 2) * viewport.zoom + viewport.y;
  return (
    centerX - nodeSize.width / 2 < 0 ||
    centerX + nodeSize.width / 2 > size.width ||
    centerY - nodeSize.height / 2 < 0 ||
    centerY + nodeSize.height / 2 > size.height
  );
}

function manualCameraViewport(
  layout: Layout,
  selected: string | undefined,
  viewport: Viewport,
  size: { width: number; height: number },
  options: CameraOptions,
) {
  const { minimumZoom, nodeSize } = options;
  const fitted = fitLineageViewport(layout, size, { minimumZoom, nodeSize, selectedKey: selected });
  const bounded = { ...viewport, zoom: Math.max(viewport.zoom, minimumZoom, fitted.zoom * 0.8) };
  const target = layout.nodes.find((node) => node.key === selected);
  if (!target || (bounded.zoom === viewport.zoom && !selectedNodeIsOutside(target, bounded, size, nodeSize)))
    return bounded;
  return {
    ...bounded,
    x: size.width / 2 - (target.x + nodeSize.width / 2) * bounded.zoom,
    y: size.height / 2 - (target.y + nodeSize.height / 2) * bounded.zoom,
  };
}

function nextCameraViewport(
  layout: Layout,
  selected: string | undefined,
  viewport: Viewport,
  size: { width: number; height: number },
  options: CameraOptions,
) {
  if (viewport.framing === 'manual') return manualCameraViewport(layout, selected, viewport, size, options);
  return {
    ...viewport,
    ...fitLineageViewport(layout, size, {
      minimumZoom: options.minimumZoom,
      nodeSize: options.nodeSize,
      selectedKey: selected,
    }),
  };
}

/** Fit the relation map; semantic node detail keeps screen text readable at every scale. */
export function useLineageCamera(
  layout: Layout,
  selected: string | undefined,
  viewport: Viewport,
  onViewport: (view: Viewport) => void,
  options: CameraOptions,
) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const latest = useRef({ layout, selected, viewport, onViewport, options });
  latest.current = { layout, selected, viewport, onViewport, options };
  // biome-ignore lint/correctness/useExhaustiveDependencies: only selection/geometry changes reframe; current callbacks and camera live in the ref so dragging does not recenter itself.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const frame = () => {
      const { layout: map, selected: key, viewport: view, onViewport: update, options: camera } = latest.current;
      const { clientWidth: width, clientHeight: height } = element;
      if (!width || !height) return;
      const measured = { width, height };
      setSize((old) => (old.width === width && old.height === height ? old : measured));
      const next = nextCameraViewport(map, key, view, measured, camera);
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
