export interface PianoRowMeasurement {
  id: string;
  top: number;
  bottom: number;
  error: boolean;
  awaitingResponse: boolean;
}

export interface PianoKey extends PianoRowMeasurement {
  trackTop: number;
  trackHeight: number;
}

export interface PianoGeometry {
  contentHeight: number;
  viewportHeight: number;
  scrollTop: number;
  trackHeight: number;
  keys: PianoKey[];
  thumbTop: number;
  thumbHeight: number;
  grabTop: number;
  grabHeight: number;
}

export function projectPianoGeometry(
  rows: readonly PianoRowMeasurement[],
  contentHeight: number,
  viewportHeight: number,
  scrollTop: number,
  trackHeight: number,
): PianoGeometry | null {
  if (
    ![contentHeight, viewportHeight, scrollTop, trackHeight].every(Number.isFinite) ||
    contentHeight <= viewportHeight ||
    viewportHeight <= 0 ||
    trackHeight <= 0
  )
    return null;
  const visible = rows.filter(
    (row) =>
      Number.isFinite(row.top) &&
      Number.isFinite(row.bottom) &&
      row.bottom > row.top &&
      row.top < contentHeight &&
      row.bottom > 0,
  );
  if (visible.length === 0) return null;
  const keys = visible.map((row, index) => {
    const top = Math.max(0, row.top);
    const bottom = Math.min(contentHeight, Math.max(row.bottom, visible[index + 1]?.top ?? row.bottom));
    return {
      ...row,
      top,
      bottom,
      trackTop: (top / contentHeight) * trackHeight,
      trackHeight: ((bottom - top) / contentHeight) * trackHeight,
    };
  });
  return {
    contentHeight,
    viewportHeight,
    trackHeight,
    keys,
    ...projectPianoScroll(contentHeight, viewportHeight, scrollTop, trackHeight),
  };
}

function projectPianoScroll(contentHeight: number, viewportHeight: number, scrollTop: number, trackHeight: number) {
  const boundedScroll = Math.max(0, Math.min(scrollTop, contentHeight - viewportHeight));
  const thumbHeight = Math.min(trackHeight, Math.max(3, (viewportHeight / contentHeight) * trackHeight));
  const center = ((boundedScroll + viewportHeight / 2) / contentHeight) * trackHeight;
  const thumbTop = Math.max(0, Math.min(center - thumbHeight / 2, trackHeight - thumbHeight));
  const grabHeight = Math.min(trackHeight, Math.max(16, thumbHeight));
  const grabTop = Math.max(0, Math.min(center - grabHeight / 2, trackHeight - grabHeight));
  return {
    scrollTop: boundedScroll,
    thumbTop,
    thumbHeight,
    grabTop,
    grabHeight,
  };
}

/** A scroll offset changes only the viewport thumb, never the content ruler or message keys. */
export function scrollPianoGeometry(geometry: PianoGeometry, scrollTop: number): PianoGeometry {
  if (!Number.isFinite(scrollTop)) return geometry;
  const viewport = projectPianoScroll(geometry.contentHeight, geometry.viewportHeight, scrollTop, geometry.trackHeight);
  return viewport.scrollTop === geometry.scrollTop ? geometry : { ...geometry, ...viewport };
}

export function pianoKeyAtOffset(keys: readonly PianoKey[], offset: number): number {
  let low = 0;
  let high = keys.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (keys[middle].bottom <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
