/**
 * RFC 1952 + RFC 1951 stored blocks. Small bundled packages trade compression
 * for an exact release identity independent of the builder's OS/zlib version.
 * Header: no flags/time/name, XFL=0, OS=255. Blocks: maximal 65535-byte chunks.
 */
export function canonicalGzip(input) {
  const bytes = Buffer.from(input);
  const blocks = [Buffer.from('1f8b08000000000000ff', 'hex')];
  for (let offset = 0; offset < bytes.length || offset === 0; offset += 65535) {
    const chunk = bytes.subarray(offset, offset + 65535);
    const header = Buffer.alloc(5);
    header[0] = offset + chunk.length === bytes.length ? 1 : 0;
    header.writeUInt16LE(chunk.length, 1);
    header.writeUInt16LE(chunk.length ^ 0xffff, 3);
    blocks.push(header, chunk);
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([...blocks, trailer]);
}
