import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { CollectiveEventEnvelope } from '../client-types.js';
import { MessageAttachments } from '../MessageAttachments.js';
import { MessageMarkdown } from '../MessageMarkdown.js';

const attachment = {
  v: 1 as const,
  attachmentId: 'att_inlinepicture',
  contentRef: 'collective-attachment:original-inline-picture',
  ownerRevision: 1 as const,
  ownerReceiptRef: 'receipt:inline',
  blobDigest: `sha256:${'a'.repeat(64)}`,
  byteLength: 120,
  mediaType: 'image/png',
  fileName: 'original.png',
};
const base: CollectiveEventEnvelope = {
  serviceInstanceId: 'svc_inlinepicture',
  collectiveId: 'col_inlinepicture',
  eventId: 'evt_inlinepicture',
  clientEventId: 'inline-picture',
  sequence: 1,
  actor: { kind: 'human', humanId: 'human_inlinepicture', displayName: 'Member' },
  target: { kind: 'channel', channelId: 'general' },
  location: { channelId: 'general' },
  recipient: { kind: 'channel' },
  acceptedAt: '2026-10-26T00:00:00.000Z',
  body: '',
  attachments: [attachment],
};
const countPictures = (event: CollectiveEventEnvelope) => {
  const html = renderToStaticMarkup(
    <>
      <MessageMarkdown source={event.body} event={event} />
      <MessageAttachments event={event} />
    </>,
  );
  return (html.match(/class="message-image-attachment"/gu) ?? []).length;
};

it('shows the same owned inline image once, including reference syntax, while keeping an unmatched attachment visible', () => {
  expect(countPictures({ ...base, body: `![原图](${attachment.contentRef})` })).toBe(1);
  expect(countPictures({ ...base, body: `![原图][original]\n\n[original]: <${attachment.contentRef}>` })).toBe(1);
});

it('does not hide an attachment merely because its URL or image syntax is mentioned as text or code', () => {
  expect(countPictures({ ...base, body: `原始地址 ${attachment.contentRef}` })).toBe(1);
  expect(countPictures({ ...base, body: `\`![代码中的例子](${attachment.contentRef})\`` })).toBe(1);
});
