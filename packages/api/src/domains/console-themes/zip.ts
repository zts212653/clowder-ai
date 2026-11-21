import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;

function safeName(name: string): boolean {
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/')) return false;
  const path = name.endsWith('/') ? name.slice(0, -1) : name;
  return !path.split('/').some((part) => !part || part === '.' || part === '..');
}
// Files the OS adds when a folder is compressed (Finder, Explorer); they are not part of the package.
function systemFile(name: string): boolean {
  return name.startsWith('__MACOSX/') || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name);
}

/** Read ordinary ZIPs by their central directory, including data-descriptor archives. */
export function readZip(bytes: Buffer): Record<string, Buffer> {
  const invalid = () => new Error('Invalid zip');
  let end = bytes.length - 22;
  const first = Math.max(0, bytes.length - 65557);
  for (; end >= first; end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  if (end < first) throw invalid();
  const count = bytes.readUInt16LE(end + 10);
  if (count > 2000) throw new Error('Too many zip entries');
  let offset = bytes.readUInt32LE(end + 16);
  const directoryEnd = offset + bytes.readUInt32LE(end + 12);
  if (
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    directoryEnd !== end
  )
    throw invalid();
  const files: Record<string, Buffer> = Object.create(null);
  const names = new Set<string>();
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directoryEnd || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const length = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (next > directoryEnd || bytes.readUInt16LE(offset + 34) !== 0) throw invalid();
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8');
    if (!safeName(name)) throw new Error('Invalid zip path');
    if (names.has(name)) throw new Error('Duplicate zip path');
    names.add(name);
    if (systemFile(name)) {
      offset = next;
      continue;
    }
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8)) throw new Error('Unsupported zip compression');
    if (size > MAX_FILE) throw new Error('Zip file exceeds 8 MB');
    total += size;
    if (total > MAX_TOTAL) throw new Error('Zip exceeds 64 MB');
    const local = bytes.readUInt32LE(offset + 42);
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid();
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > bytes.readUInt32LE(end + 16)) throw invalid();
    const content = bytes.subarray(start, start + compressed);
    let data: Buffer;
    try {
      data = method === 8 ? inflateRawSync(content, { maxOutputLength: MAX_FILE }) : content;
    } catch {
      throw invalid();
    }
    if (data.length !== size || crc32(data) !== checksum) throw invalid();
    if (!name.endsWith('/')) files[name] = data;
    offset = next;
  }
  if (offset !== directoryEnd) throw invalid();
  return files;
}

/** Standard UTF-8, deflated ZIP; no platform-specific wrapper or ZIP64 required. */
export function writeZip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const name of Object.keys(files).sort()) {
    const filename = Buffer.from(name);
    const data = files[name];
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12); // 1980-01-01 (DOS date).
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed);
    directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
