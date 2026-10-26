// @vitest-environment jsdom
import { type CollectiveMessageAttachment, collectiveComposerDraftSchema } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from '../Composer.js';
import { type MessageExpressionPort, MessageExpressionProvider } from '../message-expression-context.js';

const files = vi.hoisted(() => ({ load: vi.fn(), discard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../pending-attachment-files.js', () => ({
  pendingAttachmentFiles: files.load,
  discardPendingAttachmentFiles: files.discard,
  savePendingAttachmentFile: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.clearAllMocks();
});

it('cannot restore a sent image from a delayed private file cache after recovering its lost ACK', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('indexedDB', {});
  const attachment: CollectiveMessageAttachment = {
    v: 1,
    attachmentId: 'att_recovery0001',
    contentRef: 'collective-attachment:recovery',
    ownerRevision: 1,
    ownerReceiptRef: 'receipt:recovery',
    blobDigest: `sha256:${'a'.repeat(64)}`,
    byteLength: 8,
    mediaType: 'image/png',
    fileName: 'already-sent.png',
  };
  const namespace = 'recovery-member';
  const key = `collective-draft:${namespace}:general:channel`;
  const content = collectiveComposerDraftSchema.parse({
    body: 'accepted before reload',
    attachments: [attachment],
    recipient: { kind: 'channel' },
    recipientLabel: '',
    entrust: false,
    responseRequested: false,
    replyNeedsSelection: false,
  });
  localStorage.setItem(key, JSON.stringify(content));
  localStorage.setItem(`${key}:service-version`, JSON.stringify({ revision: 1, fingerprint: JSON.stringify(content) }));
  let restore!: (value: unknown[]) => void;
  let discarded = false;
  files.discard.mockImplementation(async () => {
    discarded = true;
  });
  files.load.mockImplementation(
    () =>
      new Promise((resolve) => {
        restore = (value) => resolve(discarded ? [] : value);
      }),
  );
  const port: MessageExpressionPort = {
    upload: vi.fn(),
    read: vi.fn().mockRejectedValue(new Error('not needed')),
    markRead: vi.fn(),
    saveDraft: vi.fn(),
    channelState: vi.fn().mockResolvedValue({
      draft: {
        revision: 2,
        clientOperationId: 'sent:accepted-id',
        content: { body: '', recipient: { kind: 'channel' }, recipientLabel: '' },
      },
      read: { sequence: 0 },
      unreadCount: 0,
    }),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MessageExpressionProvider value={port}>
          <Composer
            namespace={namespace}
            channelId="general"
            placeholder="Message"
            delivery={{ kind: 'idle' }}
            onSend={vi.fn()}
          />
        </MessageExpressionProvider>,
      ),
    );
    expect(container.querySelector('textarea')?.value).toBe('');
    await act(async () => restore([{ id: 'cached-upload', file: new File(['old'], 'already-sent.png'), attachment }]));
    expect(container.querySelectorAll('.cafe-attachment-preview')).toHaveLength(0);
    expect(files.discard).toHaveBeenCalledWith(key, [attachment.attachmentId]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
