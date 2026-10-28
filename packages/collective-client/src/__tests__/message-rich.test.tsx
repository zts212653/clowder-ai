import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ChannelMessage } from '../ChannelMessage.js';
import type { CollectiveEventEnvelope } from '../client-types.js';

const event: CollectiveEventEnvelope = {
  serviceInstanceId: 'svc_richmessage',
  collectiveId: 'col_richmessage',
  eventId: 'evt_richmessage',
  clientEventId: 'rich-message',
  sequence: 1,
  actor: { kind: 'human', humanId: 'human_owner', displayName: 'Member' },
  target: { kind: 'channel', channelId: 'general' },
  location: { channelId: 'general' },
  recipient: { kind: 'channel' },
  body: '',
  acceptedAt: '2026-10-26T00:00:00.000Z',
  richBlocks: [
    { v: 1, id: 'card', kind: 'card', title: '一起读', bodyMarkdown: '**原文在这里**' },
    { v: 1, id: 'check', kind: 'checklist', items: [{ id: 'source', text: '先看原文', checked: true }] },
    {
      v: 1,
      id: 'diff',
      kind: 'diff',
      filePath: 'notes.txt',
      diff: 'diff --git a/notes.txt b/notes.txt\n@@ -1 +1 @@\n-before\n+after',
    },
    {
      v: 1,
      id: 'choices',
      kind: 'interactive',
      interactiveType: 'select',
      title: '一起选',
      options: [{ id: 'read', label: '继续读原文' }],
    },
  ],
};

it('presents the applicable public F22 blocks instead of silently reducing a rich-only event to an empty message', () => {
  const html = renderToStaticMarkup(
    <ChannelMessage
      thread={{ root: event, replies: [] }}
      onOpenTopic={vi.fn()}
      onMention={vi.fn()}
      onOpenMember={vi.fn()}
    />,
  );
  expect(html).toContain('<strong>原文在这里</strong>');
  expect(html).toContain('先看原文');
  expect(html).toContain('notes.txt');
  expect(html).toContain('before');
  expect(html).toContain('继续读原文');
  expect(html).not.toContain('/api/private');
});
