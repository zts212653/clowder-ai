import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import sharp from 'sharp';
import { readWorkspaceFileMetadata } from '../src/domains/workspace/workspace-file-metadata.js';

test('reads real image dimensions without guessing dimensions for malformed or non-image files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-image-metadata-'));
  try {
    const file = join(root, 'landscape.png');
    await writeFile(
      file,
      await sharp({ create: { width: 320, height: 160, channels: 3, background: '#fbf8f3' } })
        .png()
        .toBuffer(),
    );
    const metadata = await readWorkspaceFileMetadata(file);
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 160);
    await writeFile(file, 'broken image');
    assert.equal((await readWorkspaceFileMetadata(file)).width, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function archive(name: string, content: string, declaredSize?: number) {
  const filename = Buffer.from(name),
    compressed = deflateRawSync(Buffer.from(content));
  const local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize ?? Buffer.byteLength(content), 24);
  central.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, central, filename, end]);
}
test('reads actual bounded OOXML page, slide and worksheet metadata; malformed or oversized metadata stays unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-metadata-'));
  try {
    for (const [file, member, xml, count, unit] of [
      ['slides.pptx', 'docProps/app.xml', '<Properties><Slides>6</Slides></Properties>', 6, 'slides'],
      ['report.docx', 'docProps/app.xml', '<Properties><Pages>12</Pages></Properties>', 12, 'pages'],
      [
        'data.xlsx',
        'xl/workbook.xml',
        '<workbook><sheets><sheet name="First"/><sheet name="Second"/></sheets></workbook>',
        2,
        'sheets',
      ],
    ] as const) {
      await writeFile(join(root, file), archive(member, xml));
      const actual = await readWorkspaceFileMetadata(join(root, file));
      assert.equal(actual.pageCount, count, file);
      assert.equal(actual.pageUnit, unit, file);
      assert.ok(actual.size > 0);
      assert.ok(actual.mime.startsWith('application/vnd.openxmlformats'));
    }
    for (const [file, bytes] of [
      ['broken.pptx', Buffer.from('not a zip')],
      ['bomb.docx', archive('docProps/app.xml', '<Pages>42</Pages>', 999999)],
      ['inflate-bomb.docx', archive('docProps/app.xml', 'x'.repeat(70000), 5)],
      ['old.doc', Buffer.from('opaque legacy binary')],
    ] as const) {
      await writeFile(join(root, file), bytes);
      assert.equal((await readWorkspaceFileMetadata(join(root, file))).pageCount, undefined, file);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
