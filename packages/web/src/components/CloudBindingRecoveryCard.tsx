'use client';

import type { ReactNode } from 'react';
import {
  type AuthorizedConversationCandidate,
  type RecoveryLoadState,
  type RecoveryPhase,
} from './cloud-binding-recovery-operations';
import { useCloudBindingRecovery } from './useCloudBindingRecovery';

function CloudIcon() {
  return (
    <svg
      aria-hidden
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <title>ChatGPT 会话</title>
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

function shortConversationId(conversationId: string): string {
  return conversationId.length > 8 ? `${conversationId.slice(0, 8)}…` : conversationId;
}

function authorizationTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function CandidateLabel({
  candidate,
  mostRecent = false,
}: {
  candidate: AuthorizedConversationCandidate;
  mostRecent?: boolean;
}) {
  return (
    <span className="min-w-0">
      <span className="block truncate text-sm font-semibold text-cafe" title={candidate.displayTitle}>
        {candidate.displayTitle ?? 'ChatGPT 会话'}
      </span>
      <span className="block truncate text-xs text-cafe-muted">
        {mostRecent ? <span className="mr-1 font-semibold text-cafe-secondary">最近授权</span> : null}
        授权于 {authorizationTime(candidate.authorizedAt)} ·{' '}
        <code className="font-mono" title={candidate.conversationId}>
          {shortConversationId(candidate.conversationId)}
        </code>
      </span>
    </span>
  );
}

function InspectConversationLink({ candidate }: { candidate: AuthorizedConversationCandidate }) {
  return (
    <a
      data-recovery-inspect-conversation
      href={candidate.chatUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 text-xs font-semibold text-cafe-secondary hover:text-cafe"
    >
      打开查看
    </a>
  );
}

function RecoveryButton({
  children,
  onClick,
  disabled,
  primary = false,
  dataPrimary,
}: {
  children: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  dataPrimary?: boolean;
}) {
  return (
    <button
      type="button"
      {...(dataPrimary ? { 'data-recovery-primary': true } : {})}
      disabled={disabled}
      className={
        primary
          ? 'rounded-full bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-accent-foreground)] transition hover:bg-cafe-accent-hover disabled:cursor-not-allowed disabled:opacity-50'
          : 'rounded-full border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-3 py-1.5 text-xs font-semibold text-cafe transition hover:bg-[var(--console-hover-bg)] disabled:opacity-50'
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function primaryLabel(phase: RecoveryPhase, alreadyBound: boolean): string {
  if (phase === 'binding') return '正在绑定…';
  if (phase === 'retrying' || phase === 'queued') return '已绑定，正在发送…';
  return alreadyBound ? '继续发送' : '绑定此会话并发送';
}

function CandidateChoices({
  candidates,
  selectedConversationId,
  busy,
  onSelect,
}: {
  candidates: AuthorizedConversationCandidate[];
  selectedConversationId: string | null;
  busy: boolean;
  onSelect: (conversationId: string) => void;
}) {
  return (
    <fieldset className="mt-1.5 grid gap-1.5">
      <legend className="sr-only">选择 ChatGPT 会话</legend>
      {candidates.map((candidate, index) => (
        <div
          key={candidate.conversationId}
          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg bg-[var(--console-card-bg)] px-3 py-2"
        >
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="cloud-recovery-conversation"
              value={candidate.conversationId}
              checked={selectedConversationId === candidate.conversationId}
              disabled={busy}
              onChange={() => onSelect(candidate.conversationId)}
            />
            <CandidateLabel candidate={candidate} mostRecent={index === 0} />
          </label>
          <InspectConversationLink candidate={candidate} />
        </div>
      ))}
    </fieldset>
  );
}

function NoCandidates({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="mt-2 text-xs text-cafe-secondary">
      <p>还没有已授权会话。打开目标 ChatGPT 对话后，点击扩展里的「授权此会话」。</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <a
          data-recovery-open-chatgpt
          href="https://chatgpt.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-full bg-cafe-accent px-3 py-1.5 font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover"
        >
          打开 ChatGPT 授权会话
        </a>
        <RecoveryButton onClick={onRefresh}>我已授权，重新检查</RecoveryButton>
      </div>
    </div>
  );
}

function ReadyRecovery({
  loadState,
  selectedConversationId,
  showChoices,
  phase,
  operationError,
  attemptId,
  onSelect,
  onToggleChoices,
  onRefresh,
  onSubmit,
}: {
  loadState: Extract<RecoveryLoadState, { kind: 'ready' }>;
  selectedConversationId: string | null;
  showChoices: boolean;
  phase: RecoveryPhase;
  operationError: string | null;
  attemptId?: string;
  onSelect: (conversationId: string) => void;
  onToggleChoices: () => void;
  onRefresh: () => void;
  onSubmit: () => void;
}) {
  if (loadState.candidates.length === 0) return <NoCandidates onRefresh={onRefresh} />;

  const selected = loadState.candidates.find((candidate) => candidate.conversationId === selectedConversationId);
  const alreadyBound = loadState.boundConversationId === selectedConversationId;
  const busy = phase !== 'idle';
  return (
    <div className="mt-2">
      <p className="text-xs text-cafe-secondary">
        {loadState.candidates.length > 1 && !selected
          ? '选择要绑定的 ChatGPT 会话：'
          : alreadyBound
            ? '当前 Thread 已绑定到：'
            : '已找到已授权的 ChatGPT 会话：'}
      </p>
      {selected && !showChoices ? (
        <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-[var(--console-card-bg)] px-3 py-2">
          <div className="min-w-0 flex-1">
            <CandidateLabel candidate={selected} mostRecent={loadState.candidates[0] === selected} />
          </div>
          <InspectConversationLink candidate={selected} />
        </div>
      ) : null}
      {showChoices ? (
        <CandidateChoices
          candidates={loadState.candidates}
          selectedConversationId={selectedConversationId}
          busy={busy}
          onSelect={onSelect}
        />
      ) : null}
      {!attemptId && loadState.retryStateError ? (
        <p role="alert" className="mt-2 text-xs text-conn-red-text">
          {loadState.retryStateError}
        </p>
      ) : null}
      {operationError ? (
        <p role="alert" className="mt-2 text-xs text-conn-red-text">
          {operationError}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2" aria-live="polite">
        <RecoveryButton primary dataPrimary disabled={busy || !selected || !attemptId} onClick={onSubmit}>
          {primaryLabel(phase, alreadyBound)}
        </RecoveryButton>
        <RecoveryButton disabled={busy} onClick={onToggleChoices}>
          {showChoices ? '收起会话列表' : '选择其他会话'}
        </RecoveryButton>
        {showChoices ? (
          <button
            type="button"
            disabled={busy}
            className="text-xs font-semibold text-cafe-secondary hover:text-cafe disabled:opacity-50"
            onClick={onRefresh}
          >
            重新检查已授权会话
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RecoveryContent({
  loadState,
  onRefresh,
  ready,
}: {
  loadState: RecoveryLoadState;
  onRefresh: () => void;
  ready: (state: Extract<RecoveryLoadState, { kind: 'ready' }>) => ReactNode;
}) {
  if (loadState.kind === 'loading') {
    return <p className="mt-2 text-xs text-cafe-muted">正在查找已授权的 ChatGPT 会话…</p>;
  }
  if (loadState.kind === 'unauthorized') {
    return <p className="mt-2 text-xs text-conn-amber-text">仅 Thread owner 可以绑定并发送。</p>;
  }
  if (loadState.kind === 'error') {
    return (
      <div className="mt-2">
        <p className="text-xs text-conn-red-text">{loadState.message}</p>
        <button
          type="button"
          className="mt-2 text-xs font-semibold text-cafe-secondary hover:text-cafe"
          onClick={onRefresh}
        >
          重新检查
        </button>
      </div>
    );
  }
  return ready(loadState);
}

export interface CloudBindingRecoveryCardProps {
  threadId: string;
  sourceMessageId: string;
  targetCatId: string;
  attemptId?: string;
}

export interface CloudBindingRecoveryCardViewProps extends CloudBindingRecoveryCardProps {
  loadState: RecoveryLoadState;
  selectedConversationId: string | null;
  showChoices: boolean;
  phase: RecoveryPhase;
  operationError: string | null;
  onRefresh: () => void;
  onSelect: (conversationId: string) => void;
  onToggleChoices: () => void;
  onSubmit: () => void;
}

export function CloudBindingRecoveryCardView(props: CloudBindingRecoveryCardViewProps) {
  return (
    <section
      aria-label="砚砚 Pro 未绑定恢复"
      data-testid="cloud-binding-recovery-card"
      className="mt-3 rounded-xl border border-conn-amber-ring bg-conn-amber-bg p-3 text-left"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0" data-testid="cloud-binding-recovery-icon">
          <CloudIcon />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-cafe">砚砚 Pro 尚未绑定到这个 Thread</p>
          <p className="mt-0.5 text-xs text-cafe-secondary">这条消息还没有发送。</p>
          <RecoveryContent
            loadState={props.loadState}
            onRefresh={props.onRefresh}
            ready={(loadState) => (
              <ReadyRecovery
                loadState={loadState}
                selectedConversationId={props.selectedConversationId}
                showChoices={props.showChoices}
                phase={props.phase}
                operationError={props.operationError}
                attemptId={props.attemptId}
                onSelect={props.onSelect}
                onToggleChoices={props.onToggleChoices}
                onRefresh={props.onRefresh}
                onSubmit={props.onSubmit}
              />
            )}
          />
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
      loadState={controller.loadState}
      selectedConversationId={controller.selectedConversationId}
      showChoices={controller.showChoices}
      phase={controller.phase}
      operationError={controller.operationError}
      onRefresh={controller.refresh}
      onSelect={controller.selectConversation}
      onToggleChoices={controller.toggleChoices}
      onSubmit={() => void controller.bindAndRetry()}
      attemptId={controller.attemptId}
    />
  );
}
