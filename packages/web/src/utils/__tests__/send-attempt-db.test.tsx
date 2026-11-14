import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { deleteSendAttempt, loadSendAttempts, type SendAttempt, saveSendAttempt } from '../send-attempt-db';

it('keeps original file bytes and pending input across reload, partitioned by account and thread', async () => {
  const file = new File([new Uint8Array([0, 1, 255, 3])], 'original.png', { type: 'image/png', lastModified: 123 });
  const attempt: SendAttempt = {
    id: 'durable-file',
    ownerUserId: 'owner-file',
    threadId: 'thread-file',
    content: '保存正文和附件',
    files: [file],
    timestamp: 100,
    status: 'sending',
    whisper: { visibility: 'whisper', whisperTo: ['opus'] },
    replyTo: 'parent',
    explicitTargetCats: ['opus'],
    messageDisposition: 'next_work',
  };
  await saveSendAttempt(attempt);
  expect(await loadSendAttempts('other-owner', attempt.threadId)).toEqual([]);
  expect(await loadSendAttempts(attempt.ownerUserId, 'other-thread')).toEqual([]);
  const [restored] = await loadSendAttempts(attempt.ownerUserId, attempt.threadId);
  expect(restored).toMatchObject({
    content: attempt.content,
    status: 'unknown',
    whisper: attempt.whisper,
    replyTo: 'parent',
    explicitTargetCats: ['opus'],
    messageDisposition: 'next_work',
  });
  expect(restored?.files[0]).toMatchObject({ name: file.name, type: file.type, lastModified: 123, size: 4 });
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(restored!.files[0]!);
  });
  expect([...new Uint8Array(bytes)]).toEqual([0, 1, 255, 3]);
  await deleteSendAttempt(restored!);
  expect(await loadSendAttempts(attempt.ownerUserId, attempt.threadId)).toEqual([]);
});
