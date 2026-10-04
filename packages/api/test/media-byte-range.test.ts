import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { streamMediaByteRange } from '../src/routes/media-byte-range.js';

test('a disconnected range response closes the owner stream before any bytes are consumed', async () => {
  const source = Readable.from([Buffer.alloc(1024)]);
  const response = streamMediaByteRange(source, { start: 100, end: 200 });
  const closed = once(response, 'close');
  response.destroy();
  await closed;
  assert.equal(source.destroyed, true);
});

test('a range spanning owner chunks returns the exact bytes and closes the source', async () => {
  const source = Readable.from([Buffer.from('ab'), Buffer.from('cdef'), Buffer.from('ghi')]);
  const response = streamMediaByteRange(source, { start: 1, end: 7 });
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'bcdefgh');
  assert.equal(source.destroyed, true);
});
