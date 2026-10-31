import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChannelMessage } from '../ChannelMessage.js';
import type { CollectiveEventEnvelope, CollectiveParticipant } from '../client-types.js';
import { TopicMessage } from '../TopicMessage.js';

const body = [
  '**清晰结论**',
  '普通第二行',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '> 这是来自原消息的引用。',
  '',
  '```ts',
  'const longToken = "collective-message-body-keeps-long-code-scrollable-without-changing-the-source";',
  '```',
  '',
  '[安全链接](https://example.com/docs)',
  '[危险链接](javascript:alert(1))',
  '[本地路径](/api/workspace/file)',
  '[邮件链接](mailto:owner@example.com)',
  '<img src=x onerror=alert(1)>',
  '![远程图片](https://tracker.example/pixel.png)',
].join('\n');

const event: CollectiveEventEnvelope = {
  serviceInstanceId: 'svc_markdown',
  collectiveId: 'col_markdown',
  eventId: 'evt_markdown',
  clientEventId: 'message-markdown',
  sequence: 1,
  actor: { kind: 'human', humanId: 'human_owner', displayName: 'You' },
  target: { kind: 'channel', channelId: '产品方向' },
  location: { channelId: '产品方向' },
  recipient: { kind: 'channel' },
  body,
  acceptedAt: '2026-09-19T12:00:00.000Z',
};

function bodyProjection(html: string): string {
  const match = html.match(/<div class="message-body message-markdown">([\s\S]*?)<\/div>/);
  if (!match?.[1]) throw new Error(`Expected shared Markdown body in: ${html}`);
  return match[1];
}

function renderChannel(): string {
  return renderToStaticMarkup(
    <ChannelMessage
      thread={{ root: event, replies: [] }}
      onOpenTopic={vi.fn()}
      onMention={vi.fn()}
      onOpenMember={vi.fn()}
    />,
  );
}

function renderTopic(): string {
  return renderToStaticMarkup(<TopicMessage event={event} onOpenMember={vi.fn()} />);
}

describe('Collective message Markdown projection', () => {
  it('keeps a Cat reply avatar tied to its exact registered participation', () => {
    const reply: CollectiveEventEnvelope = {
      ...event,
      actor: {
        kind: 'agent',
        human: { humanId: 'human_owner', displayName: 'You' },
        agent: { agentId: 'sol', displayName: '缅因猫（Sol）' },
        provenance: {
          connectionId: 'con_owner',
          endpointId: 'end_owner',
          endpointLabel: 'You 的 Café',
          catId: 'sol',
          sessionRef: 'invocation:reply',
        },
      },
    };
    const avatarDataUrl = 'data:image/webp;base64,UklGRg==';
    const participants: CollectiveParticipant[] = [
      {
        serviceInstanceId: event.serviceInstanceId,
        collectiveId: event.collectiveId,
        connectionId: 'con_owner',
        endpointId: 'end_owner',
        endpointLabel: 'You 的 Café',
        humanId: 'human_owner',
        humanDisplayName: 'You',
        catId: 'sol',
        displayName: '缅因猫（Sol）',
        channelIds: ['产品方向'],
        participationRevision: 1,
        availability: 'declared',
        avatarDataUrl,
      },
    ];
    expect(renderToStaticMarkup(<TopicMessage event={reply} participants={participants} />)).toContain(avatarDataUrl);
    const [candidate] = participants;
    if (!candidate) throw new Error('Expected participant');
    expect(
      renderToStaticMarkup(<TopicMessage event={reply} participants={[{ ...candidate, connectionId: 'con_other' }]} />),
    ).not.toContain(avatarDataUrl);
  });

  it('renders one safe read-only subset identically in Channel and Topic', () => {
    const channelBody = bodyProjection(renderChannel());
    const topicBody = bodyProjection(renderTopic());

    expect(topicBody).toBe(channelBody);
    expect(channelBody).toContain('<strong>清晰结论</strong>');
    expect(channelBody).toContain('<br/>\n普通第二行');
    expect(channelBody).toContain('<ul>');
    expect(channelBody).toContain('<blockquote>');
    expect(channelBody).toContain('<pre><code class="language-ts">');
    expect(channelBody).toContain('href="https://example.com/docs"');
    expect(channelBody).toContain('target="_blank"');
    expect(channelBody).toContain('rel="noreferrer noopener"');
  });

  it('keeps untrusted HTML, dangerous links, and remote images inert', () => {
    const projection = bodyProjection(renderChannel());

    expect(projection).toContain('&lt;img src=x onerror=alert(1)&gt;');
    for (const label of ['危险链接', '本地路径', '邮件链接']) {
      expect(projection).toContain(label);
      expect(projection).not.toMatch(new RegExp(`<a[^>]*>${label}</a>`));
    }
    expect(projection).toContain('远程图片');
    expect(projection).not.toContain('javascript:');
    expect(projection).not.toContain('mailto:');
    expect(projection).not.toContain('href="/api/workspace/file"');
    expect(projection).not.toContain('<img');
  });
});
