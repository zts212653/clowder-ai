import type { VideoProjectCanvasRegion, VideoProjectReviewRegion } from './video-project-review.js';
import type { VideoProjectScreening, VideoProjectScreeningFrame } from './video-project-screening.js';

type Point = { x: number; y: number };
type Rectangle = Point & { width: number; height: number };

export type { VideoProjectCanvasRegion } from './video-project-review.js';

function contentPixels(frame: VideoProjectScreeningFrame): Rectangle {
  return frame.contentRect ?? { x: 0, y: 0, width: frame.displayWidth, height: frame.displayHeight };
}

function inverseRotation(frame: VideoProjectScreeningFrame, rectangle: Rectangle): Rectangle {
  const { x, y, width, height } = rectangle;
  switch (frame.rotation) {
    case 90:
      return { x: y, y: 1 - x - width, width: height, height: width };
    case 180:
      return { x: 1 - x - width, y: 1 - y - height, width, height };
    case 270:
      return { x: 1 - y - height, y: x, width: height, height: width };
    default:
      return rectangle;
  }
}

/** Decoded points in bars or beyond the display are not canvas evidence. */
export function displayPointToProjectCanvas(
  screening: Pick<VideoProjectScreening, 'mapping'>,
  point: Point,
): Point | null {
  const frame = screening.mapping.frame;
  const content = contentPixels(frame);
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < content.x ||
    point.y < content.y ||
    point.x >= content.x + content.width ||
    point.y >= content.y + content.height
  )
    return null;
  const rotated = inverseRotation(frame, {
    x: (point.x - content.x) / content.width,
    y: (point.y - content.y) / content.height,
    width: 0,
    height: 0,
  });
  return { x: rotated.x * frame.canvasWidth, y: rotated.y * frame.canvasHeight };
}

/** Return a separate canvas region; never relabel display pixels or clip a box crossing a black bar. */
export function displayRegionToProjectCanvas(
  screening: Pick<VideoProjectScreening, 'mapping' | 'media'>,
  region: VideoProjectReviewRegion,
): VideoProjectCanvasRegion | null {
  const frame = screening.mapping.frame;
  const content = contentPixels(frame);
  const { bbox } = region;
  if (
    region.coordinateSpace !== 'display-pixels' ||
    region.width !== frame.displayWidth ||
    region.height !== frame.displayHeight ||
    region.rotation !== screening.media.media.rotation ||
    !Object.values(bbox).every(Number.isFinite) ||
    bbox.width <= 0 ||
    bbox.height <= 0 ||
    bbox.x < content.x ||
    bbox.y < content.y ||
    bbox.x + bbox.width > content.x + content.width ||
    bbox.y + bbox.height > content.y + content.height
  )
    return null;
  const mapped = inverseRotation(frame, {
    x: (bbox.x - content.x) / content.width,
    y: (bbox.y - content.y) / content.height,
    width: bbox.width / content.width,
    height: bbox.height / content.height,
  });
  return {
    coordinateSpace: 'canvas-pixels',
    width: frame.canvasWidth,
    height: frame.canvasHeight,
    rotation: 0,
    bbox: {
      x: mapped.x * frame.canvasWidth,
      y: mapped.y * frame.canvasHeight,
      width: mapped.width * frame.canvasWidth,
      height: mapped.height * frame.canvasHeight,
    },
  };
}
