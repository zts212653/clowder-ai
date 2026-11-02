import { expect, it } from 'vitest';
import {
  collectiveComposerDraftSchema,
  collectiveEventEnvelopeSchema,
  collectiveHumanMessageRequestSchema,
} from '../index.js';

const attachment = (id: string, mediaType: string, fileName: string) => ({
  v: 1 as const,
  attachmentId: `att_${id}00000000`,
  contentRef: `collective-attachment:${id}`,
  ownerRevision: 1 as const,
  ownerReceiptRef: `receipt:${id}`,
  blobDigest: `sha256:${'a'.repeat(64)}`,
  byteLength: 12,
  mediaType,
  fileName,
});
const attachments = [
  attachment('image', 'image/png', 'picture.png'),
  attachment('audio', 'audio/webm', 'voice.webm'),
  attachment('file', 'text/plain', 'notes.txt'),
] as const;
const blocks = [
  { v: 1, id: 'card', kind: 'card', title: '一起看看', bodyMarkdown: '**可公开内容**' },
  { v: 1, id: 'diff', kind: 'diff', filePath: 'notes.txt', diff: '@@ -1 +1 @@\n-before\n+after' },
  { v: 1, id: 'check', kind: 'checklist', items: [{ id: 'one', text: '先读原文', checked: true }] },
  {
    v: 1,
    id: 'gallery',
    kind: 'media_gallery',
    items: [{ url: attachments[0].contentRef }],
  },
  { v: 1, id: 'audio', kind: 'audio', url: attachments[1].contentRef },
  { v: 1, id: 'choices', kind: 'interactive', interactiveType: 'select', options: [{ id: 'yes', label: '继续聊' }] },
  {
    v: 1,
    id: 'file',
    kind: 'file',
    url: attachments[2].contentRef,
    fileName: 'notes.txt',
  },
  { v: 1, id: 'widget', kind: 'html_widget', html: '<button onclick="this.textContent=\'已点击\'">试一下</button>' },
];
const request = {
  serviceInstanceId: 'svc_service01',
  collectiveId: 'col_collective01',
  clientEventId: 'rich-send',
  location: { channelId: 'general' },
  recipient: { kind: 'channel' },
  body: '',
  attachments,
  richBlocks: blocks,
};

it('retains all eight applicable F22 blocks in a content-only public message and its private draft', () => {
  expect(collectiveHumanMessageRequestSchema.parse(request).richBlocks).toEqual(blocks);
  expect(
    collectiveComposerDraftSchema.parse({
      body: '',
      recipient: { kind: 'channel' },
      recipientLabel: '',
      attachments,
      richBlocks: blocks,
    }).richBlocks,
  ).toEqual(blocks);
});

it('rejects borrowed private actions, duplicate identities, forged media labels and unbound media', () => {
  const invalid = [
    [{ ...blocks[0], meta: { approvalId: 'private' } }],
    [
      {
        ...blocks[5],
        options: [{ id: 'yes', label: 'Approve', action: { type: 'callback', endpoint: '/api/private' } }],
      },
    ],
    [blocks[0], blocks[0]],
    [
      {
        ...blocks[5],
        options: [
          { id: 'yes', label: 'A' },
          { id: 'yes', label: 'B' },
        ],
      },
    ],
    [{ ...blocks[3], items: [{ url: 'https://private-cafe.invalid/image.png' }] }],
    [{ ...blocks[3], items: [{ url: attachments[1].contentRef }] }],
    [{ ...blocks[6], fileName: 'misleading.exe' }],
  ];
  for (const richBlocks of invalid)
    expect(collectiveHumanMessageRequestSchema.safeParse({ ...request, richBlocks }).success).toBe(false);
  expect(collectiveHumanMessageRequestSchema.safeParse({ ...request, attachments: undefined }).success).toBe(false);
});

it('uses the same content-byte boundary before publication and when reading the retained event', () => {
  const widget = { v: 1, id: 'large-widget', kind: 'html_widget', html: '' };
  const richBlocks = [widget];
  const content = { body: '', richBlocks };
  widget.html = 'x'.repeat(192 * 1024 - new TextEncoder().encode(JSON.stringify(content)).length);
  const input = { ...request, attachments: undefined, richBlocks };
  expect(collectiveHumanMessageRequestSchema.safeParse(input).success).toBe(true);
  const retained = {
    ...input,
    eventId: 'evt_retained01',
    sequence: 1,
    actor: { kind: 'human', humanId: 'human_owner001', displayName: 'Member' },
    target: { kind: 'channel', channelId: 'general' },
    acceptedAt: '2026-10-26T00:00:00.000Z',
  };
  expect(collectiveEventEnvelopeSchema.parse(retained).richBlocks).toEqual(richBlocks);
  widget.html += 'x';
  expect(collectiveHumanMessageRequestSchema.safeParse(input).success).toBe(false);
  expect(collectiveEventEnvelopeSchema.safeParse(retained).success).toBe(false);
});
