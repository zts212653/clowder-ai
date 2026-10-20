import type { ExplorationPositionedNode } from './exploration-lineage';

interface LineageViewportLayout {
  nodes: ReadonlyArray<ExplorationPositionedNode>;
  width: number;
  height: number;
}

export function fitLineageViewport(
  layout: LineageViewportLayout,
  size: { width: number; height: number },
  options: {
    minimumZoom: number;
    nodeSize: { width: number; height: number };
    selectedKey?: string;
  },
) {
  const { minimumZoom, nodeSize } = options;
  const fitZoom = Math.max(
    0.001,
    Math.min(1, size.width / Math.max(1, layout.width), size.height / Math.max(1, layout.height)),
  );
  const zoom = Math.max(minimumZoom, fitZoom);
  const scaledWidth = layout.width * zoom;
  const scaledHeight = layout.height * zoom;
  const target = layout.nodes.find((node) => node.key === options.selectedKey);
  const desiredX = target ? size.width / 2 - (target.x + nodeSize.width / 2) * zoom : (size.width - scaledWidth) / 2;
  const desiredY = target
    ? size.height / 2 - (target.y + nodeSize.height / 2) * zoom
    : (size.height - scaledHeight) / 2;
  const x =
    scaledWidth <= size.width
      ? (size.width - scaledWidth) / 2
      : Math.max(size.width - scaledWidth - 12, Math.min(12, desiredX));
  const y =
    scaledHeight <= size.height
      ? (size.height - scaledHeight) / 2
      : Math.max(size.height - scaledHeight - 12, Math.min(12, desiredY));
  return { x, y, zoom };
}
