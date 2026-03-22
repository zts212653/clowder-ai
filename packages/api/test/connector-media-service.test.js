import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

describe('ConnectorMediaService', () => {
  it('downloads feishu image and stores locally', async () => {
    const { ConnectorMediaService } = await import('../dist/infrastructure/connectors/media/ConnectorMediaService.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'media-test-'));

    const mockFeishuDownload = mock.fn(async () => Buffer.from('fake-image-data'));
    const service = new ConnectorMediaService({
      mediaDir: tempDir,
      feishuDownloadFn: mockFeishuDownload,
    });

    const result = await service.download('feishu', {
      type: 'image',
      platformKey: 'img_v2_abc123',
    });

    assert.ok(result.localUrl.startsWith('/api/connector-media/'));
    assert.ok(result.absPath.startsWith(tempDir));
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(mockFeishuDownload.mock.calls.length, 1);

    const content = await readFile(result.absPath);
    assert.deepEqual(content, Buffer.from('fake-image-data'));

    await rm(tempDir, { recursive: true });
  });

  it('downloads telegram audio and stores locally', async () => {
    const { ConnectorMediaService } = await import('../dist/infrastructure/connectors/media/ConnectorMediaService.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'media-test-'));

    const mockTelegramDownload = mock.fn(async () => Buffer.from('fake-voice-data'));
    const service = new ConnectorMediaService({
      mediaDir: tempDir,
      telegramDownloadFn: mockTelegramDownload,
    });

    const result = await service.download('telegram', {
      type: 'audio',
      platformKey: 'telegram-file-id-123',
      duration: 5,
    });

    assert.ok(result.localUrl.startsWith('/api/connector-media/'));
    assert.ok(result.absPath.endsWith('.ogg'));
    assert.equal(result.mimeType, 'audio/ogg');

    await rm(tempDir, { recursive: true });
  });

  it('uses fileName extension for file type', async () => {
    const { ConnectorMediaService } = await import('../dist/infrastructure/connectors/media/ConnectorMediaService.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'media-test-'));
    const service = new ConnectorMediaService({
      mediaDir: tempDir,
      feishuDownloadFn: async () => Buffer.from('data'),
    });

    const result = await service.download('feishu', {
      type: 'file',
      platformKey: 'file_key_123',
      fileName: 'report.pdf',
    });

    assert.ok(result.absPath.endsWith('.pdf'));
    assert.equal(result.originalFileName, 'report.pdf');
    assert.equal(result.mimeType, 'application/pdf');

    await rm(tempDir, { recursive: true });
  });

  it('passes messageId to feishu download function', async () => {
    const { ConnectorMediaService } = await import('../dist/infrastructure/connectors/media/ConnectorMediaService.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'media-test-'));

    const mockFeishuDownload = mock.fn(async () => Buffer.from('img-with-msgid'));
    const service = new ConnectorMediaService({
      mediaDir: tempDir,
      feishuDownloadFn: mockFeishuDownload,
    });

    await service.download('feishu', {
      type: 'image',
      platformKey: 'img_v2_abc',
      messageId: 'om_msg_789',
    });

    assert.equal(mockFeishuDownload.mock.calls.length, 1);
    const callArgs = mockFeishuDownload.mock.calls[0].arguments;
    assert.equal(callArgs[0], 'img_v2_abc');
    assert.equal(callArgs[1], 'image');
    assert.equal(callArgs[2], 'om_msg_789');

    await rm(tempDir, { recursive: true });
  });

  it('setFeishuDownloadFn wires late-bound download function', async () => {
    const { ConnectorMediaService } = await import('../dist/infrastructure/connectors/media/ConnectorMediaService.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'media-test-'));

    const service = new ConnectorMediaService({ mediaDir: tempDir });

    await assert.rejects(
      () => service.download('feishu', { type: 'image', platformKey: 'key' }),
      /No download function for connector/,
    );

    const lateFn = mock.fn(async () => Buffer.from('late-bound-data'));
    service.setFeishuDownloadFn(lateFn);

    const result = await service.download('feishu', {
      type: 'image',
      platformKey: 'img_late',
      messageId: 'om_late_123',
    });

    assert.equal(lateFn.mock.calls.length, 1);
    assert.ok(result.localUrl.startsWith('/api/connector-media/'));

    const content = await readFile(result.absPath);
    assert.deepEqual(content, Buffer.from('late-bound-data'));

    await rm(tempDir, { recursive: true });
  });

  it('setTelegramDownloadFn wires late-bound download function', async () => {
    const { ConnectorMediaService } = await import('../dist/infrastructure/connectors/media/ConnectorMediaService.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'media-test-'));

    const service = new ConnectorMediaService({ mediaDir: tempDir });

    const lateFn = mock.fn(async () => Buffer.from('tg-late'));
    service.setTelegramDownloadFn(lateFn);

    const result = await service.download('telegram', {
      type: 'audio',
      platformKey: 'tg-file-id',
    });

    assert.equal(lateFn.mock.calls.length, 1);
    assert.ok(result.absPath.endsWith('.ogg'));

    await rm(tempDir, { recursive: true });
  });

  it('throws for unsupported connector', async () => {
    const { ConnectorMediaService } = await import('../dist/infrastructure/connectors/media/ConnectorMediaService.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'media-test-'));
    const service = new ConnectorMediaService({ mediaDir: tempDir });

    await assert.rejects(
      () => service.download('unknown', { type: 'image', platformKey: 'key' }),
      /No download function for connector/,
    );

    await rm(tempDir, { recursive: true });
  });
});
