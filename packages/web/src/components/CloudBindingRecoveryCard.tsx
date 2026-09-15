'use client';

import { personalChromeSettingsHref } from '@/utils/personal-chrome-settings';
import {
  CloudConversationChoices,
  ConversationDetails,
  ConversationSummary,
  OpenConversation,
} from './CloudConversationChoices';
import type { RecoveryDeliveryStatus, RecoveryLoadState, RecoveryPhase } from './cloud-binding-recovery-operations';
import { useCloudBindingRecovery } from './useCloudBindingRecovery';

export interface CloudBindingRecoveryCardProps {
  threadId: string;
  sourceMessageId: string;
  targetCatId: string;
  attemptId?: string;
  deliveryStatus?: RecoveryDeliveryStatus;
}

export interface CloudBindingRecoveryCardViewProps extends CloudBindingRecoveryCardProps {
  loadState: RecoveryLoadState;
  selectedConversationId: string | null;
  showChoices: boolean;
  phase: RecoveryPhase;
  operationError: string | null;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onToggleChoices: () => void;
  onSubmit: () => void;
}

function ConnectionIcon() {
  return (
    <svg
      aria-hidden
      data-testid="cloud-binding-recovery-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 h-5 w-5 shrink-0"
    >
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

const primaryClass =
  'rounded-lg bg-cafe-accent px-3 py-2 text-sm font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:cursor-not-allowed disabled:opacity-50';
const secondaryClass =
  'rounded-lg border border-[var(--console-border-soft)] px-3 py-2 text-xs font-semibold text-cafe hover:bg-[var(--console-hover-bg)] disabled:opacity-50';

function recoveryHeading(props: CloudBindingRecoveryCardViewProps): [string, string] {
  if (props.deliveryStatus === 'sent') return ['已发送到 ChatGPT', '砚砚 Pro 已收到这条消息，回复会回到这里。'];
  if (props.phase === 'binding') return ['正在连接砚砚 Pro…', '正在保存当前对话的连接。'];
  if (props.phase === 'retrying') return ['已连接，正在提交发送…', '正在继续发送原来的这条消息。'];
  if (
    props.phase === 'queued' ||
    (props.deliveryStatus === 'sending' && props.loadState.kind === 'loading') ||
    (props.loadState.kind === 'ready' && props.loadState.retryState === 'pending')
  )
    return ['消息已进入发送流程', '正在等待 ChatGPT 的送达确认。'];
  const connected = props.loadState.kind === 'ready' && props.loadState.boundConversationId !== null;
  if (props.loadState.kind === 'ready' && props.loadState.connectionIssue)
    return ['连接组件尚未就绪', props.loadState.connectionIssue];
  const title = connected ? '砚砚 Pro 已连接到这个对话' : '选择砚砚 Pro 要继续的对话';
  if (props.loadState.kind === 'loading') return [title, '正在读取会话与发送状态…'];
  if (props.deliveryStatus === 'unknown') return [title, '暂时无法确认原消息是否送达，请查看原对话。'];
  if (props.attemptId)
    return [
      title,
      connected ? '原消息尚未完成发送，可以继续发送。' : '这条消息还没有发送。请选择要连接的 ChatGPT 会话。',
    ];
  return [
    title,
    connected ? '后续在这里召唤砚砚 Pro，会继续使用已连接的会话。' : '连接后，在这里召唤砚砚 Pro 就会继续使用该会话。',
  ];
}

function ReadyRecovery(
  props: CloudBindingRecoveryCardViewProps & { loadState: Extract<RecoveryLoadState, { kind: 'ready' }> },
) {
  const { loadState, selectedConversationId, showChoices, phase, onRefresh } = props;
  if (loadState.candidates.length === 0)
    return (
      <div className="mt-3 text-sm text-cafe-secondary">
        <p>还没有已授权会话。打开目标 ChatGPT 对话后，点击扩展里的「授权此会话」。</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            data-recovery-open-chatgpt
            href="https://chatgpt.com/"
            target="_blank"
            rel="noopener noreferrer"
            className={primaryClass}
          >
            打开 ChatGPT 授权会话
          </a>
          <button type="button" onClick={onRefresh} className={secondaryClass}>
            我已授权，重新检查
          </button>
        </div>
      </div>
    );
  const selected = loadState.candidates.find((candidate) => candidate.conversationId === selectedConversationId);
  const alreadyBound = selected !== undefined && loadState.boundConversationId === selectedConversationId;
  const busy = ['binding', 'retrying', 'queued'].includes(phase) || loadState.retryState === 'pending';
  const label =
    phase === 'binding'
      ? '正在连接…'
      : phase === 'retrying'
        ? '正在提交…'
        : busy
          ? '等待送达确认…'
          : props.attemptId
            ? alreadyBound
              ? '继续发送'
              : '连接并发送'
            : '连接此会话';
  const showPrimary = !alreadyBound || Boolean(props.attemptId) || busy;
  return (
    <div>
      {loadState.connectionIssue ? (
        <a
          href={personalChromeSettingsHref(props.threadId)}
          className="mt-2 inline-block text-xs font-semibold text-cafe-interactive hover:underline"
        >
          检查连接组件
        </a>
      ) : null}
      {showChoices ? (
        <CloudConversationChoices
          candidates={loadState.candidates}
          selectedConversationId={selectedConversationId}
          boundConversationId={loadState.boundConversationId}
          busy={busy}
          onSelect={props.onSelect}
        />
      ) : selected ? (
        <div className="mt-3 rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-3 py-2">
          <div className="flex items-start gap-3">
            <ConversationSummary candidate={selected} connected={alreadyBound} />
            <OpenConversation candidate={selected} />
          </div>
          <ConversationDetails candidate={selected} />
        </div>
      ) : null}
      {loadState.candidates.some((candidate) => !candidate.displayTitle) ? (
        <p className="mt-2 text-xs text-cafe-muted">
          部分会话的名称尚未同步。打开对应原对话后，点击「刷新名称与发送状态」。
        </p>
      ) : null}
      {loadState.titleSyncMessage ? (
        <p role="status" className="mt-2 text-xs text-cafe-secondary">
          {loadState.titleSyncMessage}
        </p>
      ) : null}
      {!props.attemptId && loadState.retryStateError ? (
        <p role="status" className="mt-3 text-xs text-cafe-secondary">
          {loadState.retryStateError}
        </p>
      ) : null}
      {props.operationError ? (
        <p role="alert" className="mt-3 text-xs text-conn-red-text">
          {props.operationError}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {showPrimary ? (
          <button
            type="button"
            data-recovery-primary
            disabled={busy || !selected || (Boolean(props.attemptId) && Boolean(loadState.connectionIssue))}
            onClick={props.onSubmit}
            className={primaryClass}
          >
            {label}
          </button>
        ) : null}
        {loadState.candidates.length > 1 ? (
          <button type="button" disabled={busy} onClick={props.onToggleChoices} className={secondaryClass}>
            {showChoices ? '收起会话列表' : '选择其他会话'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={phase === 'binding' || phase === 'retrying'}
          onClick={onRefresh}
          className="px-1 py-2 text-xs font-semibold text-cafe-secondary hover:text-cafe"
        >
          刷新名称与发送状态
        </button>
      </div>
      {!alreadyBound && props.attemptId ? (
        <p className="mt-2 text-xs text-cafe-muted">
          连接并发送这条消息；以后在本对话中召唤砚砚 Pro，也会继续使用它。可随时更换。
        </p>
      ) : null}
    </div>
  );
}

export function CloudBindingRecoveryCardView(props: CloudBindingRecoveryCardViewProps) {
  const [title, description] = recoveryHeading(props);
  const sent = props.deliveryStatus === 'sent';
  return (
    <section
      aria-label="砚砚 Pro 会话连接"
      data-testid="cloud-binding-recovery-card"
      className="mt-3 rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-4 text-left"
    >
      <div className="flex items-start gap-2 text-cafe">
        <ConnectionIcon />
        <div className="min-w-0 flex-1">
          <div role="status" aria-live="polite">
            <p className="text-sm font-semibold">{title}</p>
            <p className="mt-1 text-xs text-cafe-secondary">{description}</p>
          </div>
          {!sent && props.loadState.kind === 'ready' ? <ReadyRecovery {...props} loadState={props.loadState} /> : null}
          {!sent && props.loadState.kind === 'unauthorized' ? (
            <p className="mt-3 text-xs text-cafe-muted">仅对话所有者可以连接会话。</p>
          ) : null}
          {!sent && props.loadState.kind === 'error' ? (
            <div className="mt-3">
              <p role="alert" className="text-xs text-conn-red-text">
                {props.loadState.message}
              </p>
              <button type="button" onClick={props.onRefresh} className={`${secondaryClass} mt-2`}>
                重新检查
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function CloudBindingRecoveryCard(props: CloudBindingRecoveryCardProps) {
  const controller = useCloudBindingRecovery(props);
  return (
    <CloudBindingRecoveryCardView
      {...props}
      {...controller}
      onRefresh={controller.refreshTitles}
      onSelect={controller.selectConversation}
      onToggleChoices={controller.toggleChoices}
      onSubmit={controller.bindAndRetry}
    />
  );
}
