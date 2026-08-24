'use client';

import { type CloudBridgeOutboundReceiptV1, isCloudBridgeOutboundReceiptV1 } from '@cat-cafe/shared';
import { getCachedCats } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';
import { HubIcon } from './hub-icons';
import { MarkdownContent } from './MarkdownContent';
import { ReplyPill } from './ReplyPill';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function getNoticeTone(meta: Readonly<Record<string, unknown>> | undefined): 'info' | 'warning' | 'error' {
  const tone = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).noticeTone : undefined;
  return tone === 'warning' || tone === 'error' ? tone : 'info';
}

const ICON_MAP: Record<string, string> = {
  lightbulb: 'sparkles',
  '\u{1F4A1}': 'sparkles',
  warning: 'alert-triangle',
  '\u{26A0}\u{FE0F}': 'alert-triangle',
  error: 'alert-triangle',
  info: 'info',
};

function NoticeIcon({ icon }: { icon?: string }) {
  const name = ICON_MAP[icon ?? ''] ?? 'info';
  return <HubIcon name={name} className="h-4.5 w-4.5" />;
}

interface SystemNoticeBarProps {
  message: ChatMessageType;
}

const RECEIPT_STATUS_LABEL: Record<CloudBridgeOutboundReceiptV1['status'], string> = {
  sent: '已确认投递',
  failed: '确认未投递',
  unknown: '投递结果未知',
};

const IDEMPOTENCY_LABEL: Record<CloudBridgeOutboundReceiptV1['idempotency']['disposition'], string> = {
  fresh: '首次投递',
  replayed: '幂等重放',
  not_attempted: '未尝试',
  unknown: '重试状态未知',
};

function CloudOutboundAudit({ message, receipt }: { message: ChatMessageType; receipt: CloudBridgeOutboundReceiptV1 }) {
  const cats = getCachedCats();
  const getCatById = (catId: string) => cats.find((cat) => cat.id === catId);
  const details = [
    `目标 @${receipt.targetCatId}`,
    RECEIPT_STATUS_LABEL[receipt.status],
    receipt.transport,
    IDEMPOTENCY_LABEL[receipt.idempotency.disposition],
    `来源 ${receipt.sourceSender.id}`,
    ...(receipt.sourceSender.invocationId ? [`来源调用 ${receipt.sourceSender.invocationId}`] : []),
    `发送调用 ${receipt.dispatchInvocationId}`,
    ...(receipt.hostMessageId ? [`Host ${receipt.hostMessageId}`] : []),
  ];

  return (
    <div
      data-cloud-outbound-status={receipt.status}
      className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-cafe-muted"
    >
      {message.replyTo && message.replyPreview && (
        <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
      )}
      {details.map((detail) => (
        <span key={detail} className="rounded-full border border-default px-2 py-0.5">
          {detail}
        </span>
      ))}
    </div>
  );
}

export function SystemNoticeBar({ message }: SystemNoticeBarProps) {
  const source = message.source;
  if (!source) return null;

  const tone = getNoticeTone(source.meta);
  const outboundReceipt = isCloudBridgeOutboundReceiptV1(source.meta?.cloudBridgeOutboundReceipt)
    ? source.meta.cloudBridgeOutboundReceipt
    : undefined;

  return (
    <div data-message-id={message.id} data-notice-tone={tone} className="flex justify-center mb-3">
      <div className="max-w-[85%] w-full">
        <div className="flex items-center gap-2 mb-1 px-1">
          <span className="system-notice-bar__label text-xs font-medium">{source.label}</span>
          <span className="text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
        </div>
        <div
          className={`system-notice-bar ${tone !== 'info' ? 'system-notice-bar--alert' : ''} rounded-2xl px-4 py-3 text-cafe-secondary`}
        >
          <div className="flex items-start gap-3">
            <span className="system-notice-bar__icon leading-none mt-0.5">
              <NoticeIcon icon={source.icon} />
            </span>
            <div className="min-w-0 flex-1 text-sm leading-6">
              <MarkdownContent content={message.content} />
              {outboundReceipt && <CloudOutboundAudit message={message} receipt={outboundReceipt} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
