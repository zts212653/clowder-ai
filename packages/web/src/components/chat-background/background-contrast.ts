export type Rgb = readonly [number, number, number];
export type SampleArea = { x: number; y: number; width: number; height: number };
export type BackgroundPalette = { veil: Rgb; text: Rgb };
type Pixels = { data: Uint8ClampedArray; width: number; height: number };

const linear = (channel: number) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = (r: number, g: number, b: number) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

function partition(values: number[], left: number, right: number): [number, number] {
  const pivot = values[(left + right) >>> 1];
  let i = left;
  let j = right;
  while (i <= j) {
    while (values[i] < pivot) i++;
    while (values[j] > pivot) j--;
    if (i <= j) {
      [values[i], values[j]] = [values[j], values[i]];
      i++;
      j--;
    }
  }
  return [i, j];
}

/** Exact order statistic without sorting every image region at each step of the opacity search. */
function quantileValue(values: number[], rank: number): number {
  let left = 0;
  let right = values.length - 1;
  let budget = 2 * Math.ceil(Math.log2(values.length + 1));
  while (left < right) {
    // Bound adversarial partition sequences; ordinary images finish in linear time.
    if (budget-- === 0) return values.slice(left, right + 1).sort((a, b) => a - b)[rank - left];
    const [i, j] = partition(values, left, right);
    if (rank <= j) right = j;
    else if (rank >= i) left = i;
    else return values[rank];
  }
  return values[rank];
}

function backgroundLuminance(veil: Rgb, opacity: number) {
  // Opaque raster channels have only 256 possible values; reuse their exact conversions for every pixel.
  const opaque = veil.map((channel) =>
    Float64Array.from({ length: 256 }, (_, value) => linear(channel * (1 - opacity) + value * opacity)),
  );
  const bare = luminance(...veil);
  return (data: Uint8ClampedArray, offset: number) => {
    if (data[offset + 3] === 255)
      return (
        0.2126 * opaque[0][data[offset]] + 0.7152 * opaque[1][data[offset + 1]] + 0.0722 * opaque[2][data[offset + 2]]
      );
    if (data[offset + 3] === 0) return bare;
    const alpha = opacity * (data[offset + 3] / 255);
    return luminance(
      veil[0] * (1 - alpha) + data[offset] * alpha,
      veil[1] * (1 - alpha) + data[offset + 1] * alpha,
      veil[2] * (1 - alpha) + data[offset + 2] * alpha,
    );
  };
}

/** CSS composites in sRGB; contrast is measured after converting the resulting pixel to linear light. */
export function backgroundContrast(
  pixels: Pixels,
  areas: readonly SampleArea[],
  palette: BackgroundPalette,
  _mode: 'light' | 'dark',
  opacity: number,
): number {
  const text = luminance(...palette.text);
  // Custom human colours can differ from the theme's usual direction; the actual pair decides the unsafe tail.
  const lightText = text > luminance(...palette.veil);
  const readPixel = backgroundLuminance(palette.veil, opacity);
  let worst = Number.POSITIVE_INFINITY;
  for (const area of areas) {
    const values: number[] = [];
    const right = Math.min(pixels.width, Math.ceil(area.x + area.width));
    const bottom = Math.min(pixels.height, Math.ceil(area.y + area.height));
    for (let y = Math.max(0, Math.floor(area.y)); y < bottom; y++) {
      for (let x = Math.max(0, Math.floor(area.x)); x < right; x++) {
        values.push(readPixel(pixels.data, (y * pixels.width + x) * 4));
      }
    }
    if (values.length === 0) continue;
    const at = (values.length - 1) * (lightText ? 0.95 : 0.05);
    const lower = Math.floor(at);
    const low = quantileValue(values, lower);
    const high = quantileValue(values, Math.ceil(at));
    const background = low + (high - low) * (at - lower);
    const ratio = lightText ? (text + 0.05) / (background + 0.05) : (background + 0.05) / (text + 0.05);
    worst = Math.min(worst, ratio);
  }
  return Number.isFinite(worst) ? worst : 0;
}

/** Largest whole-percent image opacity (0–40%) whose weakest text region still passes 4.5:1. */
export function readableBackgroundOpacity(
  pixels: Pixels,
  areas: readonly SampleArea[],
  palette: BackgroundPalette,
  mode: 'light' | 'dark',
): number {
  // A brighter image can improve an initially unreadable native pair. Search the bounded whole-percent
  // domain directly rather than discarding passing higher values after a failing midpoint.
  for (let percent = 40; percent >= 0; percent--) {
    if (backgroundContrast(pixels, areas, palette, mode, percent / 100) >= 4.5) return percent / 100;
  }
  return 0;
}
