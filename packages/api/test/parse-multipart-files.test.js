import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('parseMultipart with mixed image + file attachments', () => {
  let uploadDir;

  beforeEach(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-parse-multipart-'));
  });

  afterEach(async () => {
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  });

  it('routes image/* to ImageContent and other files to FileContent', async () => {
    const { parseMultipart } = await import('../dist/routes/parse-multipart.js');

    const parts = [
      { type: 'field', fieldname: 'content', value: 'check these files' },
      { type: 'field', fieldname: 'threadId', value: 'test-thread' },
      {
        type: 'file',
        fieldname: 'images',
        filename: 'photo.png',
        mimetype: 'image/png',
        toBuffer: async () => Buffer.from('fake-png'),
      },
      {
        type: 'file',
        fieldname: 'images',
        filename: 'report.pdf',
        mimetype: 'application/pdf',
        toBuffer: async () => Buffer.from('fake-pdf'),
      },
    ];

    const mockRequest = { parts: () => createAsyncIterator(parts) };
    const result = await parseMultipart(mockRequest, uploadDir);

    assert.ok(!('error' in result), `should not return error: ${result.error ?? ''}`);
    assert.equal(result.content, 'check these files');
    assert.equal(result.contentBlocks.length, 3);
    assert.equal(result.contentBlocks[0].type, 'text');
    assert.equal(result.contentBlocks[1].type, 'image');
    assert.equal(result.contentBlocks[2].type, 'file');
    assert.equal(result.contentBlocks[2].fileName, 'report.pdf');
    assert.equal(result.contentBlocks[2].mimeType, 'application/pdf');
    assert.equal(result.contentBlocks[2].fileSize, 'fake-pdf'.length);
  });

  it('rejects unsupported non-image MIME types', async () => {
    const { parseMultipart } = await import('../dist/routes/parse-multipart.js');

    const parts = [
      { type: 'field', fieldname: 'content', value: 'bad file' },
      {
        type: 'file',
        fieldname: 'images',
        filename: 'evil.exe',
        mimetype: 'application/x-msdownload',
        toBuffer: async () => Buffer.from('bad'),
      },
    ];

    const mockRequest = { parts: () => createAsyncIterator(parts) };
    const result = await parseMultipart(mockRequest, uploadDir);

    assert.ok('error' in result, 'should return error for unsupported MIME');
    assert.ok(result.error.includes('Unsupported'));
  });

  it('handles image-only uploads (backward compat)', async () => {
    const { parseMultipart } = await import('../dist/routes/parse-multipart.js');

    const parts = [
      { type: 'field', fieldname: 'content', value: 'just an image' },
      {
        type: 'file',
        fieldname: 'images',
        filename: 'photo.png',
        mimetype: 'image/png',
        toBuffer: async () => Buffer.from('fake-png'),
      },
    ];

    const mockRequest = { parts: () => createAsyncIterator(parts) };
    const result = await parseMultipart(mockRequest, uploadDir);

    assert.ok(!('error' in result));
    assert.equal(result.contentBlocks.length, 2);
    assert.equal(result.contentBlocks[0].type, 'text');
    assert.equal(result.contentBlocks[1].type, 'image');
  });

  it('handles file-only uploads (no images)', async () => {
    const { parseMultipart } = await import('../dist/routes/parse-multipart.js');

    const parts = [
      { type: 'field', fieldname: 'content', value: 'just a file' },
      {
        type: 'file',
        fieldname: 'files',
        filename: 'data.json',
        mimetype: 'application/json',
        toBuffer: async () => Buffer.from('{"key":"value"}'),
      },
    ];

    const mockRequest = { parts: () => createAsyncIterator(parts) };
    const result = await parseMultipart(mockRequest, uploadDir);

    assert.ok(!('error' in result));
    assert.equal(result.contentBlocks.length, 2);
    assert.equal(result.contentBlocks[0].type, 'text');
    assert.equal(result.contentBlocks[1].type, 'file');
    assert.equal(result.contentBlocks[1].fileName, 'data.json');
  });
});

async function* createAsyncIterator(items) {
  for (const item of items) {
    yield item;
  }
}
