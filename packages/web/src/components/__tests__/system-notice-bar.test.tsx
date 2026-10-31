import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';
import { SystemNoticeBar } from '../SystemNoticeBar';

vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));
vi.mock('@/components/thread-chat/MessageNavigationContext', () => ({ useMessageNavigation: () => vi.fn() }));

function renderNotice(
  message: Partial<ChatMessageType> & Pick<ChatMessageType, 'content' | 'timestamp' | 'source'>,
  timelineMessages: readonly ChatMessageType[] = [],
) {
  return renderToStaticMarkup(
    <SystemNoticeBar
      message={
        {
          id: 'notice-1',
          type: 'connector',
          ...message,
        } as ChatMessageType
      }
      threadId="thread-pro"
      timelineMessages={timelineMessages}
    />,
  );
}

describe('SystemNoticeBar', () => {
  it('shows the exact authenticated reply while retaining an unknown browser receipt', () => {
    const outbound = {
      v: 1,
      sourceMessageId: 'source119',
      sourceSender: { kind: 'cat', id: 'codex61-sol' },
      dispatchInvocationId: 'dispatch119',
      targetCatId: 'gpt-pro',
      status: 'unknown',
      transport: 'host',
      idempotency: { keyKind: 'source_message_id', disposition: 'unknown' },
    };
    const source = { id: 'source119', type: 'assistant', catId: 'codex61-sol', content: 'new source', timestamp: 1 };
    const answer = {
      id: 'reply122',
      type: 'assistant',
      from: { kind: 'agent', catId: 'gpt-pro' },
      catId: 'gpt-pro',
      content: '收到 Sol',
      timestamp: 3,
      replyTo: 'source119',
      origin: 'callback',
      extra: {
        isExplicitPost: true,
        cloudBridgeReturn: {
          v: 1,
          threadId: 'thread-pro',
          sourceMessageId: 'source119',
          targetCatId: 'gpt-pro',
          dispatchInvocationId: 'dispatch119',
        },
      },
    };
    const html = renderNotice(
      {
        content: '投递给 Pro 的结果未知',
        timestamp: 2,
        replyTo: 'source119',
        source: {
          connector: 'cloud-bridge-status',
          label: '云端猫投递',
          icon: 'info',
          meta: { noticeTone: 'warning', cloudBridgeOutboundReceipt: outbound },
        },
      },
      [source, answer] as ChatMessageType[],
    );
    expect(html).toContain('已收到 Pro 回复');
    expect(html).toContain('本次浏览器 Host 回执未确认');
    expect(html).toContain('data-cloud-outbound-status="unknown"');
    expect(html).not.toContain('投递给 Pro 的结果未知');
    expect(html).not.toContain('已确认投递');
  });

  const receipt = {
    v: 1,
    kind: 'approval_decision_receipt',
    producerId: 'F128',
    canonicalProposalId: 'proposal_receipt_example',
    resolution: 'accepted',
    approvalCardRef: { threadId: 'thread_example', messageId: 'original-card' },
    requesterCatId: 'codex61-sol',
    decidedAt: 1793030000000,
    decidedBy: 'default-user',
  };

  it('keeps an approval receipt out of the centered system box and never exposes its machine body', () => {
    const html = renderNotice({
      content: '审批结果：线程提案 proposal_receipt_example 已批准。',
      timestamp: receipt.decidedAt,
      source: {
        connector: 'approval-hub',
        label: 'Host 审批结果回执',
        icon: 'info',
        meta: { approvalDecisionReceipt: receipt },
      },
    });
    expect(html).toContain('chat-approval-receipt');
    expect(html).toContain('justify-end');
    expect(html).not.toContain('system-notice-bar');
    expect(html).not.toContain('proposal_receipt_example');
  });

  it('does not expose the machine body when an approval receipt metadata record is malformed', () => {
    const html = renderNotice({
      content: '审批结果：线程提案 proposal_receipt_example 已批准。',
      timestamp: receipt.decidedAt,
      source: {
        connector: 'approval-hub',
        label: 'Host 审批结果回执',
        icon: 'info',
        meta: { approvalDecisionReceipt: { ...receipt, resolution: 'expired' } },
      },
    });
    expect(html).not.toContain('proposal_receipt_example');
    expect(html).toContain('chat-approval-receipt');
  });

  it('uses Clowder cafe surface styling for info notices instead of a generic blue card', () => {
    const html = renderNotice({
      content: '想交接给 @codex？把它单独放到新起一行开头，才能触发交接。',
      timestamp: new Date('2026-04-16T12:34:00+08:00').getTime(),
      source: {
        connector: 'inline-mention-hint',
        label: 'Routing hint',
        icon: 'lightbulb',
        meta: { noticeTone: 'info' },
      },
    });

    expect(html).toContain('data-notice-tone="info"');
    expect(html).toContain('system-notice-bar');
    expect(html).toContain('text-cafe-secondary');
    expect(html).not.toContain('bg-blue-50');
    expect(html).not.toContain('text-slate-900');
    expect(html).not.toMatch(/text-\[#[0-9A-Fa-f]{3,6}\]/);
    expect(html).not.toMatch(/border-\[#[0-9A-Fa-f]{3,6}\]/);
  });

  it('keeps warning emphasis in metadata while leaving the notice body on the shared cafe palette', () => {
    const html = renderNotice({
      content: '服务刚重启，opus 的进行中请求已中断，请重新发送。',
      timestamp: new Date('2026-04-16T12:34:00+08:00').getTime(),
      source: {
        connector: 'startup-reconciler',
        label: '重启通知',
        icon: '⚠️',
        meta: { noticeTone: 'warning' },
      },
    });

    expect(html).toContain('data-notice-tone="warning"');
    expect(html).toContain('system-notice-bar--alert');
    expect(html).toContain('text-cafe-muted');
    expect(html).toContain('text-cafe-secondary');
    expect(html).not.toContain('bg-amber-50');
    expect(html).not.toContain('text-amber-950');
    expect(html).not.toMatch(/text-\[#[0-9A-Fa-f]{3,6}\]/);
    expect(html).not.toMatch(/border-\[#[0-9A-Fa-f]{3,6}\]/);
  });

  it('renders a source-bound cloud audit with exact hydrated preview and honest receipt fields', () => {
    const html = renderNotice({
      content: '已发送给 @gpt-pro，等待它从 ChatGPT 云端会话回写。',
      timestamp: new Date('2026-08-23T12:34:00-07:00').getTime(),
      replyTo: 'source-message-1',
      replyPreview: { senderCatId: 'codex-sol', content: '审查 exact source 回程' },
      source: {
        connector: 'cloud-bridge-status',
        label: '云端猫投递',
        icon: 'info',
        meta: {
          noticeTone: 'info',
          cloudBridgeOutboundReceipt: {
            v: 1,
            sourceMessageId: 'source-message-1',
            sourceSender: { kind: 'cat', id: 'codex-sol', invocationId: 'inv-source-1' },
            dispatchInvocationId: 'inv-cloud-1',
            targetCatId: 'gpt-pro',
            status: 'sent',
            transport: 'host',
            hostMessageId: 'host-message-1',
            idempotency: { keyKind: 'source_message_id', disposition: 'replayed' },
          },
        },
      },
    });

    expect(html).toContain('审查 exact source 回程');
    expect(html).toContain('@gpt-pro');
    expect(html).toContain('host');
    expect(html).toContain('host-message-1');
    expect(html).toContain('幂等重放');
    expect(html).toContain('inv-cloud-1');
    expect(html).not.toContain('conversation-7');
  });
});
