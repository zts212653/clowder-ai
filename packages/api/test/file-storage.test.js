import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('saveUploadedFiles', () => {
  let uploadDir;

  beforeEach(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-file-upload-'));
  });

  afterEach(async () => {
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  });

  it('saves a valid PDF file and returns FileContent metadata', async () => {
    const { saveUploadedFiles } = await import('../dist/utils/file-storage.js');

    const fakeFile = createMockFile('report.pdf', 'application/pdf', Buffer.from('fake-pdf-content'));
    const saved = await saveUploadedFiles([fakeFile], uploadDir);

    assert.equal(saved.length, 1);
    assert.ok(saved[0].absPath.startsWith(resolve(uploadDir)));
    assert.ok(saved[0].urlPath.startsWith('/uploads/'));
    assert.equal(saved[0].content.type, 'file');
    assert.equal(saved[0].content.fileName, 'report.pdf');
    assert.equal(saved[0].content.mimeType, 'application/pdf');
    assert.equal(saved[0].content.fileSize, 'fake-pdf-content'.length);

    const files = await readdir(uploadDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.pdf'));
  });

  it('saves a text/plain file and returns FileContent', async () => {
    const { saveUploadedFiles } = await import('../dist/utils/file-storage.js');

    const fakeFile = createMockFile('notes.txt', 'text/plain', Buffer.from('hello world'));
    const saved = await saveUploadedFiles([fakeFile], uploadDir);

    assert.equal(saved.length, 1);
    assert.equal(saved[0].content.type, 'file');
    assert.equal(saved[0].content.fileName, 'notes.txt');
    assert.equal(saved[0].content.mimeType, 'text/plain');
  });

  it('saves an application/octet-stream file', async () => {
    const { saveUploadedFiles } = await import('../dist/utils/file-storage.js');

    const fakeFile = createMockFile('data.bin', 'application/octet-stream', Buffer.from([0x00, 0x01, 0x02]));
    const saved = await saveUploadedFiles([fakeFile], uploadDir);

    assert.equal(saved.length, 1);
    assert.equal(saved[0].content.type, 'file');
    assert.equal(saved[0].content.mimeType, 'application/octet-stream');
  });

  it('rejects unsupported MIME types', async () => {
    const { saveUploadedFiles, FileUploadError } = await import('../dist/utils/file-storage.js');

    const fakeFile = createMockFile('evil.exe', 'application/x-msdownload', Buffer.from('bad'));
    await assert.rejects(
      () => saveUploadedFiles([fakeFile], uploadDir),
      (err) => err instanceof FileUploadError && err.message.includes('Unsupported'),
    );
  });

  it('rejects files exceeding 50MB', async () => {
    const { saveUploadedFiles, FileUploadError } = await import('../dist/utils/file-storage.js');

    const bigBuffer = Buffer.alloc(51 * 1024 * 1024, 0x42);
    const fakeFile = createMockFile('huge.zip', 'application/zip', bigBuffer);
    await assert.rejects(
      () => saveUploadedFiles([fakeFile], uploadDir),
      (err) => err instanceof FileUploadError && err.message.includes('too large'),
    );
  });

  it('sanitizes malicious filenames preserving extension', async () => {
    const { saveUploadedFiles } = await import('../dist/utils/file-storage.js');

    const fakeFile = createMockFile('../../etc/passwd.pdf', 'application/pdf', Buffer.from('safe'));
    const saved = await saveUploadedFiles([fakeFile], uploadDir);

    assert.equal(saved.length, 1);
    assert.ok(saved[0].content.fileName.endsWith('.pdf'));
    assert.ok(!saved[0].content.fileName.includes('..'));
    assert.ok(!saved[0].content.fileName.includes('/'));
  });

  it('saves multiple files with unique names', async () => {
    const { saveUploadedFiles } = await import('../dist/utils/file-storage.js');

    const files = [
      createMockFile('a.pdf', 'application/pdf', Buffer.from('aaa')),
      createMockFile('b.txt', 'text/plain', Buffer.from('bbb')),
    ];
    const saved = await saveUploadedFiles(files, uploadDir);

    assert.equal(saved.length, 2);
    assert.notEqual(saved[0].absPath, saved[1].absPath);

    const diskFiles = await readdir(uploadDir);
    assert.equal(diskFiles.length, 2);
  });

  it('skips image files (they go through saveUploadedImages)', async () => {
    const { saveUploadedFiles } = await import('../dist/utils/file-storage.js');

    const imageFile = createMockFile('photo.png', 'image/png', Buffer.from('fake-png'));
    const pdfFile = createMockFile('doc.pdf', 'application/pdf', Buffer.from('fake-pdf'));
    const saved = await saveUploadedFiles([imageFile, pdfFile], uploadDir);

    assert.equal(saved.length, 1);
    assert.equal(saved[0].content.fileName, 'doc.pdf');
  });

  it('handles same-name uploads without EEXIST 500 (P1 regression)', async () => {
    const { saveUploadedFiles } = await import('../dist/utils/file-storage.js');

    const fileA = createMockFile('report.pdf', 'application/pdf', Buffer.from('version-1'));
    const fileB = createMockFile('report.pdf', 'application/pdf', Buffer.from('version-2'));
    const saved = await saveUploadedFiles([fileA, fileB], uploadDir);

    assert.equal(saved.length, 2);
    assert.notEqual(saved[0].absPath, saved[1].absPath);
    assert.equal(saved[0].content.fileName, 'report.pdf');
    assert.equal(saved[1].content.fileName, 'report.pdf');

    const diskFiles = await readdir(uploadDir);
    assert.equal(diskFiles.length, 2);
  });

  it('handles second upload of same filename across calls (P1 regression)', async () => {
    const { saveUploadedFiles } = await import('../dist/utils/file-storage.js');

    const file1 = createMockFile('data.json', 'application/json', Buffer.from('{"v":1}'));
    const saved1 = await saveUploadedFiles([file1], uploadDir);
    assert.equal(saved1.length, 1);

    const file2 = createMockFile('data.json', 'application/json', Buffer.from('{"v":2}'));
    const saved2 = await saveUploadedFiles([file2], uploadDir);
    assert.equal(saved2.length, 1);

    assert.notEqual(saved1[0].absPath, saved2[0].absPath);
    assert.equal(saved1[0].content.fileName, 'data.json');
    assert.equal(saved2[0].content.fileName, 'data.json');
  });
});

describe('isImageFile', () => {
  it('returns true for image MIME types', async () => {
    const { isImageFile } = await import('../dist/utils/file-storage.js');
    assert.equal(isImageFile('image/png'), true);
    assert.equal(isImageFile('image/jpeg'), true);
    assert.equal(isImageFile('image/gif'), true);
    assert.equal(isImageFile('image/webp'), true);
  });

  it('returns false for non-image MIME types', async () => {
    const { isImageFile } = await import('../dist/utils/file-storage.js');
    assert.equal(isImageFile('application/pdf'), false);
    assert.equal(isImageFile('text/plain'), false);
    assert.equal(isImageFile('application/octet-stream'), false);
  });
});

function createMockFile(filename, mimetype, buffer) {
  return {
    filename,
    mimetype,
    toBuffer: async () => buffer,
  };
}
