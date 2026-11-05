/** Recognize raster transport bytes, never treat their Base64 alphabet as text. */
export function decodeRasterPayload(value, key, parent) {
  const uri = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/i.exec(value);
  const typed = key === 'data' && ['image', 'base64'].includes(parent?.type);
  const mime = uri?.[1].toLowerCase() ?? (typed ? (parent.mimeType ?? parent.media_type) : undefined);
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) return null;
  const data = uri?.[2] ?? value;
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) return null;
  const valid =
    (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (mime === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) ||
    (mime === 'image/gif' && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) ||
    (mime === 'image/webp' &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP');
  return valid ? bytes : null;
}
