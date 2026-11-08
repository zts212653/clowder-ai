import { afterEach, expect, it, vi } from 'vitest';
import { copyArtworkPixels } from '../file-action-client';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), write: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://file.test', apiFetch: transport.fetch }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function clipboardFixture() {
  const bitmap = { width: 320, height: 200, close: vi.fn() };
  const draw = vi.fn();
  const png = new Blob(['visible frame'], { type: 'image/png' });
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => bitmap),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  const dimensions: number[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done) {
    dimensions.push([this.width, this.height]);
    done(png);
  });
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(readonly data: Record<string, Promise<Blob>>) {}
    },
  );
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: transport.write } });
  transport.fetch.mockResolvedValue(new Response('atlas', { headers: { 'Content-Type': 'image/png' } }));
  transport.write.mockImplementation(async ([item]) => {
    await item.data['image/png'];
  });
  return { bitmap, draw, dimensions };
}

it.each([
  { x: 160, y: 0, width: 160, height: 100 },
  { x: 0, y: 100, width: 160, height: 100 },
])('copies only the displayed GIF frame at $x,$y rather than its complete atlas', async (frame) => {
  const f = clipboardFixture();
  await copyArtworkPixels(document.createElement('img'), 'http://file.test/atlas.png', frame);
  expect(f.dimensions).toEqual([[160, 100]]);
  expect(f.draw).toHaveBeenCalledWith(f.bitmap, frame.x, frame.y, 160, 100, 0, 0, 160, 100);
  expect(f.bitmap.close).toHaveBeenCalledOnce();
});

it('refuses a frame outside the decoded atlas instead of copying the wrong pixels', async () => {
  const f = clipboardFixture();
  await expect(
    copyArtworkPixels(document.createElement('img'), 'http://file.test/atlas.png', {
      x: 300,
      y: 0,
      width: 160,
      height: 100,
    }),
  ).rejects.toThrow('invalid_pixels');
  expect(f.draw).not.toHaveBeenCalled();
  expect(f.bitmap.close).toHaveBeenCalledOnce();
});
