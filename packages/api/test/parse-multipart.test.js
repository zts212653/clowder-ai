import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { parseMultipart } from '../dist/routes/parse-multipart.js';

test('parseMultipart drains file stream before waiting for remaining parts', async () => {
  const uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-parse-multipart-'));
  let fileConsumed = false;
  let releaseIterator = false;

  const request = {
    parts: async function* () {
      yield { type: 'field', fieldname: 'content', value: 'hello with image' };

      yield {
        type: 'file',
        fieldname: 'images',
        filename: 'cat.png',
        mimetype: 'image/png',
        toBuffer: async () => {
          fileConsumed = true;
          return Buffer.from('fake-png');
        },
      };

      while (!fileConsumed && !releaseIterator) {
        await delay(5);
      }

      yield { type: 'field', fieldname: 'threadId', value: 'thread-test' };
    },
  };

  try {
    const parsed = await Promise.race([
      parseMultipart(request, uploadDir),
      (async () => {
        await delay(300);
        throw new Error('parseMultipart timed out waiting for file stream drain');
      })(),
    ]);

    assert.ok(!('error' in parsed), 'expected multipart parse success');
    assert.equal(parsed.threadId, 'thread-test');
    assert.equal(parsed.contentBlocks.length, 2);
    assert.equal(parsed.contentBlocks[0].type, 'text');
    assert.equal(parsed.contentBlocks[1].type, 'image');
  } finally {
    releaseIterator = true;
    await rm(uploadDir, { recursive: true, force: true });
  }
});

test('parseMultipart preserves a mounted composer revision as a number', async () => {
  const request = {
    parts: async function* () {
      yield { type: 'field', fieldname: 'content', value: '带图发送' };
      yield { type: 'field', fieldname: 'threadId', value: 'thread-test' };
      yield { type: 'field', fieldname: 'composerDraftRevision', value: '3' };
    },
  };
  const parsed = await parseMultipart(request, tmpdir());
  assert.ok(!('error' in parsed));
  assert.equal(parsed.composerDraftRevision, 3);
});
