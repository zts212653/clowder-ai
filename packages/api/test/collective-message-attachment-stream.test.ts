import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { authorizedAttachmentStream } from '../src/domains/collaborative-content/collective-artifact/message-attachment-stream.js';

test('discarding an unconsumed owner response before request cancellation does not emit an unhandled source error', async () => {
  const source = Readable.from([Buffer.from('private bytes')]);
  const controller = new AbortController();
  const body = authorizedAttachmentStream(source, async () => {}, controller.signal);
  body.destroy();
  controller.abort();
  await setImmediate();
  assert.equal(body.destroyed, true);
  assert.equal(source.destroyed, true);
});

test('cancelling an active owner read discards buffered bytes and destroys both streams', async () => {
  const source = Readable.from([Buffer.from('first'), Buffer.from('second')]);
  const controller = new AbortController();
  const body = authorizedAttachmentStream(source, async () => {}, controller.signal);
  const iterator = body[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.toString(), 'first');
  controller.abort();
  const after = await iterator.next().catch(() => ({ done: true }));
  assert.equal(after.done, true);
  assert.equal(body.destroyed, true);
  assert.equal(source.destroyed, true);
});
