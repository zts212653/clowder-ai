// @vitest-environment jsdom

import type { CollectiveMessageAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from '../Composer.js';
import { type MessageExpressionPort, MessageExpressionProvider } from '../message-expression-context.js';

vi.mock('../pending-attachment-files.js', () => ({
  beginPendingAttachmentFile: vi.fn(),
  savePendingAttachmentFile: vi.fn().mockResolvedValue(undefined),
  pendingAttachmentFiles: vi.fn().mockResolvedValue([]),
  discardPendingAttachmentFiles: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('queues a multi-file selection within the Service limit and keeps the person’s selected order', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:upload-fixture', revokeObjectURL: vi.fn() });
  const pending: (() => void)[] = [];
  let active = 0,
    peak = 0,
    index = 0;
  const port: MessageExpressionPort = {
    upload: vi.fn(async (file: File): Promise<CollectiveMessageAttachment> => {
      const id = index++;
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => pending.push(resolve));
      active--;
      return {
        v: 1,
        attachmentId: `att_uploadorder${id}`,
        contentRef: `collective-attachment:upload-order-${id}`,
        ownerRevision: 1,
        ownerReceiptRef: `receipt:${id}`,
        blobDigest: `sha256:${'a'.repeat(64)}`,
        byteLength: file.size,
        mediaType: 'text/plain',
        fileName: file.name,
      };
    }),
    read: vi.fn().mockResolvedValue(new Blob(['preview'])),
    markRead: vi.fn(),
    saveDraft: vi.fn(),
    channelState: vi.fn().mockResolvedValue({
      draft: {
        revision: 0,
        content: {
          body: '',
          recipient: { kind: 'channel' },
          recipientLabel: '',
        },
      },
      read: { sequence: 0 },
      unreadCount: 0,
    }),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MessageExpressionProvider value={port}>
          <Composer
            namespace="upload-order"
            channelId="general"
            placeholder="Message"
            delivery={{ kind: 'idle' }}
            onSend={vi.fn()}
          />
        </MessageExpressionProvider>,
      ),
    );
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('The normal multi-file picker is missing');
    Object.defineProperty(input, 'files', {
      value: ['first.txt', 'second.txt', 'third.txt'].map((name) => new File(['x'], name)),
    });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(peak, 'A single selection must not overflow the Service’s two in-flight upload slots').toBeLessThanOrEqual(
      2,
    );
    for (let count = 0; count < 3; count++) {
      await act(async () => {
        const finish = pending.shift();
        if (!finish) throw new Error('A selected file was not queued');
        finish();
      });
    }
    expect([...host.querySelectorAll('.cafe-attachment-name')].map((node) => node.textContent)).toEqual([
      'first.txt',
      'second.txt',
      'third.txt',
    ]);
    expect(port.upload).toHaveBeenCalledTimes(3);
  } finally {
    for (const finish of pending) finish();
    await act(async () => root.unmount());
    host.remove();
  }
});
