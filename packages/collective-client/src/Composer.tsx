import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { CollectiveIcon } from './CollectiveIcon.js';
import { ComposerTray } from './ComposerTray.js';
import { actorDisplayName } from './channel-model.js';
import type {
  CollectiveEventEnvelope,
  CollectiveParticipant,
  CollectiveRecipient,
  DeliveryState,
} from './client-types.js';
import { emptyDraft, type ReplySelection, readDraft, replyDraftError, selectReply } from './composer-draft.js';
import { MemberAvatar } from './MemberAvatar.js';
import { participantKey, participantRecipient } from './participant-identity.js';

export interface HumanMention {
  readonly humanId: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
}
export interface MentionSelection {
  readonly recipient: CollectiveRecipient;
  readonly label: string;
}
function selectionAvailable(
  recipient: CollectiveRecipient,
  participants: readonly CollectiveParticipant[],
  humans: readonly HumanMention[],
  channelId: string,
) {
  if (recipient.kind === 'human') return humans.some((human) => human.humanId === recipient.humanId);
  return (
    recipient.kind !== 'agent' ||
    participants.some(
      (item) =>
        item.connectionId === recipient.connectionId &&
        item.catId === recipient.agentId &&
        item.humanId === recipient.humanId &&
        item.participationRevision === recipient.participationRevision &&
        item.availability === 'declared' &&
        item.channelIds.includes(channelId),
    )
  );
}

export function Composer({
  placeholder,
  channelId,
  namespace,
  participants = [],
  humans = [],
  delivery,
  onSend,
  mention,
  compact = false,
  rootEventId,
  inputId,
  reply,
  replyEvents,
}: {
  readonly placeholder: string;
  readonly channelId: string;
  readonly namespace: string;
  readonly participants?: readonly CollectiveParticipant[];
  readonly humans?: readonly HumanMention[];
  readonly delivery: DeliveryState;
  readonly onSend: (
    body: string,
    recipient: CollectiveRecipient,
    entrust: boolean,
    responseRequested: boolean,
    replyToEventId?: string,
  ) => Promise<void>;
  readonly mention?: MentionSelection;
  readonly compact?: boolean;
  readonly rootEventId?: string;
  readonly inputId?: string;
  readonly reply?: ReplySelection;
  readonly replyEvents?: readonly CollectiveEventEnvelope[];
}) {
  const draftKey = `collective-draft:${namespace}:${channelId}:${rootEventId ?? 'channel'}`;
  const [draft, setDraft] = useState(() => readDraft(draftKey));
  const [mentionQuery, setMentionQuery] = useState<string>();
  const [activeOption, setActiveOption] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [entrust, setEntrust] = useState(draft.entrust ?? false);
  const [responseRequested, setResponseRequested] = useState(draft.responseRequested ?? false);
  const [pending, setPending] = useState(false);
  const [storageNotice, setStorageNotice] = useState<string>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const listId = useId();
  const available = selectionAvailable(draft.recipient, participants, humans, channelId);
  const replyEvent = replyEvents?.find((event) => event.eventId === draft.replyToEventId);
  const replyError = replyDraftError(draft, replyEvents, participants, channelId);
  const unresolved = /(^|\s)@/u.test(draft.body);
  const inputPlaceholder = replyEvent ? `回复 ${actorDisplayName(replyEvent)} 的消息` : placeholder;
  const query = (mentionQuery ?? '').toLocaleLowerCase();
  const options = [
    ...participants
      .filter((item) => item.availability === 'declared' && item.channelIds.includes(channelId))
      .map((item) => ({
        key: participantKey(item),
        label: item.displayName,
        detail: `${item.humanDisplayName} · ${item.endpointLabel} (${item.endpointId.slice(-6)})`,
        recipient: participantRecipient(item),
        kind: 'agent' as const,
        avatarUrl: item.avatarDataUrl,
      })),
    ...humans.map((human) => ({
      key: human.humanId,
      label: human.displayName,
      detail: '成员 · 人',
      recipient: { kind: 'human' as const, humanId: human.humanId },
      kind: 'human' as const,
      avatarUrl: human.avatarUrl,
    })),
  ].filter((item) => `${item.label} ${item.detail}`.toLocaleLowerCase().includes(query));
  const activeIndex = Math.min(activeOption, Math.max(0, options.length - 1));
  const disabled =
    pending || delivery.kind === 'requesting' || !draft.body.trim() || !available || unresolved || !!replyError;

  useEffect(() => {
    try {
      window.localStorage.setItem(draftKey, JSON.stringify({ ...draft, entrust, responseRequested }));
      setStorageNotice(undefined);
    } catch {
      if (draft.body) setStorageNotice('浏览器未能保存草稿，请保留当前页面。');
    }
  }, [draftKey, draft, entrust, responseRequested]);
  useEffect(() => {
    if (!mention) return;
    setDraft((current) => ({
      ...current,
      recipient: mention.recipient,
      recipientLabel: mention.label,
      replyNeedsSelection: false,
    }));
    setEntrust(false);
    setResponseRequested(false);
    inputRef.current?.focus();
  }, [mention]);
  useEffect(() => {
    if (!reply) return;
    setDraft((current) => selectReply(current, reply));
    setEntrust(false);
    setResponseRequested(false);
    inputRef.current?.focus();
  }, [reply]);

  const select = (index: number) => {
    const selected = options[index];
    if (!selected) return;
    const caret = inputRef.current?.selectionStart ?? draft.body.length;
    setDraft((current) => ({
      ...current,
      body: current.body.slice(0, caret).replace(/(^|\s)@[^\s@]*$/u, '$1') + current.body.slice(caret),
      recipient: selected.recipient,
      recipientLabel: selected.label,
      replyNeedsSelection: false,
    }));
    setMentionQuery(undefined);
    setEntrust(false);
    setResponseRequested(false);
    inputRef.current?.focus();
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || sending.current) return;
    sending.current = true;
    setPending(true);
    try {
      if (draft.replyToEventId) {
        await onSend(draft.body.trim(), draft.recipient, entrust, responseRequested, draft.replyToEventId);
      } else {
        await onSend(draft.body.trim(), draft.recipient, entrust, responseRequested);
      }
      setDraft((current) => {
        if (current.body !== draft.body) return current;
        return current.replyToEventId ? { ...current, body: '' } : emptyDraft;
      });
      setEntrust(false);
      setResponseRequested(false);
      setExpanded(false);
      setMentionQuery(undefined);
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (mentionQuery !== undefined) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionQuery(undefined);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveOption(
          (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(1, options.length),
        );
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && options.length) {
        event.preventDefault();
        select(activeIndex);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!disabled) event.currentTarget.form?.requestSubmit();
    }
  };
  return (
    <form
      className={compact ? 'composer composer-compact' : 'composer'}
      onSubmit={(event) => void submit(event).catch(() => undefined)}
    >
      {mentionQuery !== undefined && (
        <div className="mention-list" id={listId} role="listbox" aria-label="选择要提到的成员">
          {options.map((option, index) => (
            <button
              key={option.key}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className="mention-option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(index)}
            >
              <MemberAvatar name={option.label} kind={option.kind} avatarUrl={option.avatarUrl} compact />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
            </button>
          ))}
          {!options.length && <p>没有找到在本频道参与的成员。</p>}
        </div>
      )}
      {replyEvent && (
        <div className="composer-recipient" role="group" aria-label="回复来源">
          <span>
            回复 {actorDisplayName(replyEvent)}：{replyEvent.body.replace(/\s+/gu, ' ').slice(0, 60)}
          </span>
        </div>
      )}
      {draft.recipient.kind !== 'channel' && (
        <div className="composer-recipient">
          <span>@{draft.recipientLabel || '已选成员'}</span>
          <button
            type="button"
            aria-label="取消点名"
            onClick={() => {
              setDraft((current) => ({
                ...current,
                recipient: { kind: 'channel' },
                recipientLabel: '',
                replyNeedsSelection: false,
              }));
              setEntrust(false);
              setResponseRequested(false);
            }}
          >
            ×
          </button>
        </div>
      )}
      {(replyError || !available) && (
        <p role="alert" className="composer-warning">
          {replyError ?? '参与设置已变化，请重新选择成员；消息尚未发送。'}
        </p>
      )}
      {unresolved && mentionQuery === undefined && (
        <p role="alert" className="composer-warning">
          请用 @ 选择当前频道的成员，或移除未确认的点名。
        </p>
      )}
      {expanded && (
        <ComposerTray
          recipientKind={draft.recipient.kind}
          entrust={entrust}
          responseRequested={responseRequested}
          onMention={() => {
            setMentionQuery('');
            setActiveOption(0);
            inputRef.current?.focus();
          }}
          onEntrust={setEntrust}
          onResponseRequested={setResponseRequested}
        />
      )}
      <div className="composer-box">
        <button
          type="button"
          className="composer-expand"
          aria-label="更多输入选项"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          +
        </button>
        <textarea
          ref={inputRef}
          id={inputId}
          value={draft.body}
          placeholder={inputPlaceholder}
          aria-label={inputPlaceholder}
          aria-autocomplete="list"
          rows={1}
          required
          disabled={pending}
          aria-controls={mentionQuery !== undefined ? listId : undefined}
          aria-activedescendant={mentionQuery !== undefined && options.length ? `${listId}-${activeIndex}` : undefined}
          onKeyDown={keyDown}
          onChange={(event) => {
            const body = event.target.value;
            setDraft((current) => ({ ...current, body }));
            const match = body.slice(0, event.target.selectionStart).match(/(?:^|\s)@([^\s@]*)$/u);
            setMentionQuery(match?.[1]);
            setActiveOption(0);
          }}
        />
        <button type="submit" className="composer-send" aria-label="发送" disabled={disabled}>
          <CollectiveIcon kind="send" />
        </button>
      </div>
      {storageNotice && (
        <p className="composer-warning" role="status">
          {storageNotice}
        </p>
      )}
      {delivery.kind !== 'idle' && (
        <p className={`delivery-state delivery-${delivery.kind}`} role="status">
          {delivery.label}
        </p>
      )}
    </form>
  );
}
