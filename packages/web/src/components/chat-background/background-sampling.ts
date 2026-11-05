import type { BackgroundOpacity, BackgroundPlacement } from '@cat-cafe/shared';
import type { ActualColours } from '@/lib/readable-name-plate';
import { useSidebarStore } from '@/stores/sidebarStore';
import type { SampleArea } from './background-contrast';
import type { BackgroundOpacityJob, ViewportSample } from './background-opacity-job';
import { readBackgroundPalettes } from './background-palette';

export function backgroundTextAreas(width: number, height: number, scale: number): SampleArea[] {
  const actual = width === window.innerWidth && height === window.innerHeight;
  const rail = document.querySelector('.cafe-world-rail')?.getBoundingClientRect();
  const settings = document.querySelector('[data-testid="settings-v2"]');
  const scaleArea = (area: SampleArea) => ({
    x: area.x * scale,
    y: area.y * scale,
    width: area.width * scale,
    height: area.height * scale,
  });
  if (actual && settings) {
    return [
      document.querySelector('.cafe-world-rail'),
      ...settings.querySelectorAll(
        '[data-console-panel="settings-nav"], [data-background-sampling-area="settings-content"]',
      ),
    ]
      .filter((element): element is Element => element !== null)
      .map((element) => element.getBoundingClientRect())
      .filter((area) => area.width > 0 && area.height > 0)
      .map((area) => scaleArea({ x: area.left, y: area.top, width: area.width, height: area.height }));
  }
  const sidebar = document.querySelector('[data-shell-sidebar="v2"]')?.getBoundingClientRect();
  const sideWidth = width >= 768 ? ((actual ? sidebar?.width : undefined) ?? useSidebarStore.getState().width) : 0;
  const left = (rail?.width ?? 52) + sideWidth;
  const column = actual
    ? document.querySelector('[data-thread-chat-reading-column]')?.getBoundingClientRect()
    : undefined;
  const readingWidth = column?.width ?? Math.min(776, width - left);
  const readingLeft = column?.left ?? left + (width - left - readingWidth) / 2;
  return [
    { x: 0, y: 0, width: rail?.width ?? 52, height },
    ...(sideWidth > 0 ? [{ x: rail?.width ?? 52, y: 0, width: sideWidth, height }] : []),
    { x: left, y: 0, width: width - left, height: 53 },
    { x: readingLeft, y: 53, width: readingWidth, height: height - 53 },
    // Other destinations can place bare descriptions outside the centred chat column.
    { x: rail?.width ?? 52, y: 0, width: width - (rail?.width ?? 52), height },
  ].map(scaleArea);
}

function captureViewport(
  image: HTMLImageElement,
  placement: BackgroundPlacement,
  viewWidth: number,
  viewHeight: number,
): ViewportSample {
  const scale = Math.min(1, 360 / viewWidth, 360 / viewHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewWidth * scale);
  canvas.height = Math.ceil(viewHeight * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Image sampling unavailable');
  const factor = placement === 'fill' ? Math.max(viewWidth / image.naturalWidth, viewHeight / image.naturalHeight) : 1;
  const w = image.naturalWidth * factor * scale;
  const h = image.naturalHeight * factor * scale;
  let left = (canvas.width - w) / 2;
  let top = (canvas.height - h) / 2;
  if (placement === 'tile') {
    left = ((left % w) - w) % w;
    top = ((top % h) - h) % h;
    for (let y = top; y < canvas.height; y += h)
      for (let x = left; x < canvas.width; x += w) context.drawImage(image, x, y, w, h);
  } else context.drawImage(image, left, top, w, h);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  return { pixels: { data, width, height }, areas: backgroundTextAreas(viewWidth, viewHeight, scale) };
}

/** Seconds of per-pixel search must never hold the thread that paints clicks and keystrokes. */
function searchOffMainThread(job: BackgroundOpacityJob): Promise<BackgroundOpacity> {
  const worker = new Worker(new URL('./background-opacity.worker.ts', import.meta.url));
  return new Promise<BackgroundOpacity>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<BackgroundOpacity>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || 'Background sampling failed'));
    worker.postMessage(
      job,
      job.viewports.map(({ pixels }) => pixels.data.buffer),
    );
  }).finally(() => worker.terminate());
}

/** Keep one durable value readable at selection time, on the accepted desktop and 390px layouts too. */
export async function sampleBackgroundOpacity(
  url: string,
  placement: BackgroundPlacement,
  actual?: ActualColours,
): Promise<BackgroundOpacity> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const palettes = readBackgroundPalettes(actual);
  const viewports = new Map([
    [`${window.innerWidth}x${window.innerHeight}`, [window.innerWidth, window.innerHeight]],
    ['1440x900', [1440, 900]],
    ['390x900', [390, 900]],
  ]);
  return searchOffMainThread({
    palettes,
    viewports: [...viewports.values()].map(([width, height]) => captureViewport(image, placement, width, height)),
  });
}
