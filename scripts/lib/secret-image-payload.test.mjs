import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { secretNativeHook } from '../secret-native-hook.mjs';
import { prepareSecretToolInput, protectSecretToolResult } from './secret-tool-io.mjs';
import { inspectSecretValue } from './secret-value-inspection.mjs';

const collision = ['AI', 'za', 'A'.repeat(35)].join('');
const secret = ['ghp', '_', 'K'.repeat(36)].join('');
function chunk(type, bytes) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([size, name, bytes, checksum]);
}
// A real, lossless PNG: the uncompressed pixel stream happens to encode a
// key-shaped substring. No credential bytes are present in the PNG itself.
function image(metadata = '') {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  for (let padding = 0; padding < 3; padding++) {
    const pixels = Buffer.alloc(129);
    Buffer.from(collision, 'base64').copy(pixels, 1 + padding);
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels, { level: 0 })),
      ...(metadata ? [chunk('tEXt', Buffer.from(`Comment\0${metadata}`))] : []),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    if (png.toString('base64').includes(collision)) return png;
  }
  throw new Error('fixture must reproduce the encoding collision');
}
function representations(png) {
  const data = png.toString('base64');
  const uri = `data:image/png;base64,${data}`;
  return [
    uri,
    { image_url: uri },
    { content: [{ type: 'image', mimeType: 'image/png', data }] },
    { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] },
  ];
}

test('raster encoding collisions preserve exact bytes and cause no native rotation notice', async () => {
  for (const original of representations(image())) {
    assert.deepEqual(inspectSecretValue(original), { value: original, rules: [] });
    let notices = 0;
    const notify = async () => notices++;
    assert.equal(await protectSecretToolResult(original, { notify }), original);
    assert.equal(
      await secretNativeHook(
        { hook_event_name: 'PostToolUse', tool_name: 'view_image', tool_response: original },
        { notify },
      ),
      null,
    );
    const prepared = prepareSecretToolInput('image', { image: original });
    try {
      assert.deepEqual(prepared.input, { image: original });
    } finally {
      prepared.dispose();
    }
    assert.equal(notices, 0);
  }
});

test('decoded image metadata and neighboring text with a configured credential still redact and notify', async () => {
  for (const original of [
    ...representations(image(secret)),
    { image_url: representations(image())[0], text: secret },
  ]) {
    let notice;
    const result = await protectSecretToolResult(original, {
      knownCredentials: [secret],
      notify: async (value) => {
        notice = value;
      },
    });
    assert.deepEqual(notice.rules, ['known-credential']);
    assert.equal(result._meta.secretExposure.rotationNotice, 'recorded');
    const output = JSON.stringify(result);
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes(image(secret).toString('base64')), false);
    assert.equal(JSON.stringify(notice).includes(secret), false);
  }
});

test('an image label alone does not exempt plain text, remote URLs or malformed encodings', () => {
  for (const original of [
    { content: [{ type: 'image', mimeType: 'image/png', data: secret }] },
    `data:image/png;base64,${secret}`,
    `https://example.test/image.png?token=${secret}`,
    { type: 'image', mimeType: 'text/plain', data: collision },
    { data: collision },
  ])
    assert.ok(inspectSecretValue(original).rules.length);
});
