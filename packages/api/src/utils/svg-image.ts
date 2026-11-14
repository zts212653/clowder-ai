import { XMLParser, XMLValidator } from 'fast-xml-parser';
import sharp from 'sharp';
import { detectRasterImageMime } from './raster-image-mime.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const tags = new Set(
  (
    'svg g defs use symbol clippath mask path rect circle ellipse line polyline polygon ' +
    'lineargradient radialgradient stop pattern filter feblend fecolormatrix fecomponenttransfer fecomposite ' +
    'feconvolvematrix fediffuselighting fedisplacementmap fedistantlight fedropshadow feflood fefunca fefuncb ' +
    'fefuncg fefuncr fegaussianblur feimage femerge femergenode femorphology feoffset fepointlight ' +
    'fespecularlighting fespotlight fetile feturbulence text tspan title desc image marker style'
  ).split(' '),
);
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});
export const MAX_SVG_BYTES = 2 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_svg');
  return value as Record<string, unknown>;
}

type RasterVisitor = (bytes: Buffer) => void;
function reference(value: string, raster?: RasterVisitor) {
  if (/^#[A-Za-z_][\w:.-]*$/.test(value)) return;
  // Embedded SVG/HTML and non-image schemes are intentionally absent.
  const data = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/.exec(value);
  if (data) {
    const bytes = Buffer.from(data[2], 'base64');
    if (bytes.toString('base64') !== data[2] || detectRasterImageMime(bytes) !== data[1])
      throw new Error('unsafe_svg_embedded_image');
    raster?.(bytes);
    return;
  }
  throw new Error('unsafe_svg_reference');
}

function styles(value: string, raster?: RasterVisitor) {
  // CSS escapes/comments can hide url(), @import and protocol tokens from a textual check.
  if (/[\\@]|\/\*|\*\//.test(value)) throw new Error('unsafe_svg_style');
  for (const match of value.matchAll(/url\s*\(\s*([^)]*)\)/gi)) {
    reference(match[1].trim().replace(/^(["'])(.*)\1$/, '$2'), raster);
  }
}

/** Strict static SVG admission. It validates the original text; it never rewrites or trusts an extension. */
export function inspectSvgImage(bytes: Buffer, raster?: RasterVisitor) {
  if (!bytes.length || bytes.length > MAX_SVG_BYTES) throw new Error('invalid_svg');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0') || /<!\s*(?:DOCTYPE|ENTITY)|<\?(?!xml\s)/i.test(text) || XMLValidator.validate(text) !== true)
    throw new Error('invalid_svg');
  const document: unknown = parser.parse(text);
  if (!Array.isArray(document)) throw new Error('invalid_svg');
  const roots = document.map(record).filter((node) => !('?xml' in node) && !('#text' in node));
  if (roots.length !== 1 || !('svg' in roots[0])) throw new Error('invalid_svg');
  let count = 0;
  function walk(nodes: unknown, depth: number) {
    if (!Array.isArray(nodes) || depth > 64) throw new Error('invalid_svg');
    for (const raw of nodes) {
      if (++count > 10000) throw new Error('invalid_svg');
      const node = record(raw);
      for (const [name, value] of Object.entries(node)) {
        if (name === ':@') {
          for (const [attr, rawValue] of Object.entries(record(value))) {
            const content = String(rawValue);
            if (
              /^on/i.test(attr) ||
              /[\\]/.test(content) ||
              (attr.includes(':') && !['xlink:href', 'xml:space', 'xml:lang', 'xmlns:xlink'].includes(attr))
            )
              throw new Error('unsafe_svg_attribute');
            if (attr === 'xmlns' && content !== SVG_NS) throw new Error('unsafe_svg_namespace');
            if (attr === 'xmlns:xlink' && content !== 'http://www.w3.org/1999/xlink')
              throw new Error('unsafe_svg_namespace');
            if (attr === 'href' || attr === 'xlink:href') reference(content, raster);
            styles(content, raster);
          }
        } else if (name !== '#text') {
          if (!tags.has(name.toLowerCase()) || name.includes(':')) throw new Error('unsafe_svg_element');
          if (name.toLowerCase() === 'style') {
            if (!Array.isArray(value)) throw new Error('unsafe_svg_style');
            for (const child of value) {
              const content = record(child);
              if (Object.keys(content).some((key) => key !== '#text')) throw new Error('unsafe_svg_style');
              styles(String(content['#text'] ?? ''), raster);
            }
          }
          walk(value, depth + 1);
        }
      }
    }
  }
  walk(roots, 0);
  const attributes = roots[0][':@'] ? record(roots[0][':@']) : {};
  let viewBox: { minX: number; minY: number; width: number; height: number } | undefined;
  if (attributes.viewBox !== undefined) {
    const values = String(attributes.viewBox)
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (values.length !== 4 || !values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0)
      throw new Error('invalid_svg');
    viewBox = { minX: values[0], minY: values[1], width: values[2], height: values[3] };
  }
  function pixelDimension(value: unknown) {
    const literal = value === undefined ? '' : String(value).trim();
    if (!literal || /^\d*\.?\d+%$/.test(literal)) return undefined;
    if (!/^\d*\.?\d+(?:px)?$/.test(literal)) throw new Error('unsupported_svg_dimensions');
    return Number(literal.replace(/px$/, ''));
  }
  function dimension(result: number | undefined) {
    if (result === undefined || !Number.isFinite(result) || result <= 0 || result > 32768)
      throw new Error('invalid_svg_dimensions');
    return Math.max(1, Math.round(result));
  }
  const explicitWidth = pixelDimension(attributes.width),
    explicitHeight = pixelDimension(attributes.height);
  const ratio = viewBox ? viewBox.width / viewBox.height : undefined;
  const width = dimension(
    explicitWidth ?? (ratio && explicitHeight !== undefined ? explicitHeight * ratio : viewBox?.width),
  );
  const height = dimension(
    explicitHeight ?? (ratio && explicitWidth !== undefined ? explicitWidth / ratio : viewBox?.height),
  );
  if (width * height > 40_000_000) throw new Error('invalid_svg_dimensions');
  return { width, height, ...(viewBox ? { viewBox } : {}) };
}

/** Verify embedded raster resources before librsvg sees them, using the same total pixel budget as the canvas. */
export async function probeSvgImage(bytes: Buffer) {
  const rasters: Buffer[] = [];
  const geometry = inspectSvgImage(bytes, (raster) => {
    if (rasters.length >= 64) throw new Error('too_many_svg_images');
    rasters.push(raster);
  });
  let pixels = geometry.width * geometry.height;
  for (const raster of rasters) {
    const decoder = sharp(raster, { limitInputPixels: 40_000_000, failOn: 'error', animated: true });
    const meta = await decoder.metadata();
    // A moving embedded picture cannot acquire the static SVG coordinate contract.
    if ((meta.pages ?? 1) !== 1 || !meta.width || !meta.height) throw new Error('unsupported_svg_image');
    if (
      detectRasterImageMime(raster) === 'image/gif' &&
      (raster.length < 13 || raster.readUInt16LE(6) !== meta.width || raster.readUInt16LE(8) !== meta.height)
    )
      throw new Error('unsupported_svg_image');
    pixels += meta.width * meta.height;
    if (pixels > 40_000_000) throw new Error('svg_image_budget');
    await decoder.timeout({ seconds: 5 }).stats();
  }
  const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' }).timeout({ seconds: 5 });
  const meta = await decoder.metadata();
  if (meta.width !== geometry.width || meta.height !== geometry.height) throw new Error('unsupported_svg_dimensions');
  await decoder.stats();
  return geometry;
}
