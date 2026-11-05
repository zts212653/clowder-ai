// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CollectiveEventEnvelope } from '../client-types.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { type MessageExpressionPort, MessageExpressionProvider } from '../message-expression-context.js';

it.each([
  false,
  true,
])('keeps an opened inline original through ordinary rerenders (source coordinates: %s)', async (sourceCoordinates) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:actual-retained-image');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const read = vi.fn(async () => new Blob(['same original bytes'], { type: 'image/png' }));
  const unused = async () => {
    throw new Error('Unused port');
  };
  const port: MessageExpressionPort = {
    read,
    upload: unused,
    saveDraft: unused,
    channelState: unused,
    markRead: unused,
  };
  const attachment = {
    v: 1 as const,
    attachmentId: 'att_continuity01',
    contentRef: 'collective-attachment:inline-continuity',
    ownerRevision: 1 as const,
    ownerReceiptRef: 'receipt:inline-continuity',
    blobDigest: `sha256:${'a'.repeat(64)}`,
    byteLength: 19,
    mediaType: 'image/png',
    fileName: 'picture.png',
  };
  const event: CollectiveEventEnvelope = {
    serviceInstanceId: 'svc_imagecontinuity',
    collectiveId: 'col_imagecontinuity',
    eventId: 'evt_imagecontinuity',
    clientEventId: 'image-continuity',
    sequence: 1,
    actor: { kind: 'human', humanId: 'human_continuity', displayName: 'Member' },
    target: { kind: 'channel', channelId: 'general' },
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: `![same picture](${attachment.contentRef})`,
    attachments: [attachment],
    acceptedAt: '2026-10-26T00:00:00.000Z',
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (next: CollectiveEventEnvelope, label: string) =>
    act(async () =>
      root.render(
        <MessageExpressionProvider value={port}>
          <MessageMarkdown event={next} source={next.body} prefix={label} sourceCoordinates={sourceCoordinates} />
        </MessageExpressionProvider>,
      ),
    );
  try {
    await render(event, '中文');
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:actual-retained-image');
    await render({ ...event }, 'English');
    expect(read).toHaveBeenCalledTimes(1);
    expect(revokeUrl).not.toHaveBeenCalled();
    expect(createUrl).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
