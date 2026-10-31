import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ComposerContext } from './ComposerContext.js';
import { ComposerFeedback } from './ComposerFeedback.js';
import { ComposerInput } from './ComposerInput.js';
import { ComposerMentionMenu } from './ComposerMentionMenu.js';
import { ComposerRichContent } from './ComposerRichContent.js';
import { ComposerTray } from './ComposerTray.js';
import { actorDisplayName } from './channel-model.js';
import type {
  CollectiveEventEnvelope,
  CollectiveParticipant,
  CollectiveRecipient,
  DeliveryState,
} from './client-types.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import {
  clearConfirmedComposerDraft,
  type ReplySelection,
  readDraft,
  replyDraftError,
  selectReply,
} from './composer-draft.js';
import { type ComposerSend, hasComposerContextContent, sendComposerMessage } from './composer-submission.js';
import { ComposerMessageQuotes } from './MessageQuotes.js';
import { useComposerAttachments } from './use-composer-attachments.js';
import { useComposerQuotes } from './use-composer-quotes.js';
import { useComposerVoice } from './use-composer-voice.js';
import { useServiceComposerDraft } from './use-service-composer-draft.js';
import { useSharedArtifactComposer } from './use-shared-artifact-composer.js';

export type { HumanMention, MentionSelection } from './composer-mentions.js';

import {
  composerMentionOptions,
  type HumanMention,
  type MentionSelection,
  selectionAvailable,
} from './composer-mentions.js';

// The coordinator keeps mention selection, reply identity and exact send/draft consumption together.
// Visual input, source context and feedback are separate components; further splitting would duplicate this state.
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
  readonly onSend: ComposerSend;
  readonly mention?: MentionSelection;
  readonly compact?: boolean;
  readonly rootEventId?: string;
  readonly inputId?: string;
  readonly reply?: ReplySelection;
  readonly replyEvents?: readonly CollectiveEventEnvelope[];
}) {
  const t = useCollectiveText();
  const language = useCollectiveLanguage();
  const draftKey = `collective-draft:${namespace}:${channelId}:${rootEventId ?? 'channel'}`;
  const [draft, setDraft] = useState(() => readDraft(draftKey));
  const fileInput = useRef<HTMLInputElement>(null);
  const attachment = useSharedArtifactComposer(draft, setDraft, rootEventId);
  const [mentionQuery, setMentionQuery] = useState<string>();
  const [activeOption, setActiveOption] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const entrust = draft.entrust ?? false;
  const setEntrust = useCallback((entrust: boolean) => setDraft((current) => ({ ...current, entrust })), []);
  const responseRequested = draft.responseRequested ?? false;
  const setResponseRequested = useCallback(
    (responseRequested: boolean) => setDraft((current) => ({ ...current, responseRequested })),
    [],
  );
  const [pending, setPending] = useState(false);
  const durable = useServiceComposerDraft({
    draftKey,
    namespace,
    channelId,
    rootEventId,
    draft,
    setDraft,
    paused: pending,
  });
  const files = useComposerAttachments(draftKey, channelId, draft, setDraft, durable.ready);
  const voice = useComposerVoice({ namespace, draftKey, channelId, rootEventId, language, draft, setDraft, durable });
  const [storageNotice, setStorageNotice] = useState<string>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useComposerQuotes(draft.contextAttachments?.length, setDraft, inputRef, setStorageNotice, language);
  const sending = useRef(false);
  const listId = useId();
  const reworkFocus =
    draft.artifactReply?.annotationId ??
    (draft.artifactRework && `${draft.artifactRework.rework.requestId}:${draft.artifactRework.ownerRevision}`);
  useEffect(() => {
    if (reworkFocus) inputRef.current?.focus();
  }, [reworkFocus]);
  const available = selectionAvailable(draft.recipient, participants, humans, channelId);
  const replyEvent = replyEvents?.find((event) => event.eventId === draft.replyToEventId);
  const replyError = replyDraftError(draft, replyEvents, participants, channelId);
  const unresolved = /(^|\s)@/u.test(draft.body);
  const inputPlaceholder = replyEvent
    ? language === 'en'
      ? `Reply to ${actorDisplayName(replyEvent)}`
      : `回复 ${actorDisplayName(replyEvent)} 的消息`
    : placeholder;
  const options = composerMentionOptions(
    participants,
    humans,
    channelId,
    (mentionQuery ?? '').toLocaleLowerCase(),
    t('成员 · 人'),
  );
  const activeIndex = Math.min(activeOption, Math.max(0, options.length - 1));
  const artifactAction = Boolean(attachment.selections.length || attachment.rework || attachment.reply);
  const mixedAttachmentAction = hasComposerContextContent(draft) && artifactAction;
  const disabled =
    pending ||
    voice.blocksSend ||
    Boolean(draft.richEditor) ||
    !durable.ready ||
    !!durable.conflict ||
    mixedAttachmentAction ||
    delivery.kind === 'requesting' ||
    (!draft.body.trim() &&
      !draft.attachments?.length &&
      !draft.contextAttachments?.length &&
      !draft.richBlocks?.length) ||
    files.pending ||
    !available ||
    unresolved ||
    !!replyError ||
    attachment.stale;

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
  }, [mention, setEntrust, setResponseRequested]);
  useEffect(() => {
    if (!reply) return;
    setDraft((current) => selectReply(current, reply));
    setEntrust(false);
    setResponseRequested(false);
    inputRef.current?.focus();
  }, [reply, setEntrust, setResponseRequested]);

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
      if (artifactAction) {
        await durable.flush(draft);
        await attachment.send(draft.body.trim(), draft.recipient);
      } else {
        await sendComposerMessage(onSend, draft, await durable.flush(draft));
      }
      const consume = artifactAction ? await durable.clearAfterAction(draft) : await durable.acknowledged(draft);
      if (consume) setDraft((current) => clearConfirmedComposerDraft(current, draft));
      if (draft.attachments?.length) await files.confirm(draft.attachments);
      if (consume) await voice.confirm(draft);
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
      data-draft-ready={durable.ready}
      onSubmit={(event) => void submit(event).catch(() => undefined)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        void files.add([...event.dataTransfer.files]);
      }}
    >
      {mentionQuery !== undefined && (
        <ComposerMentionMenu options={options} id={listId} active={activeIndex} onSelect={select} />
      )}
      <ComposerContext
        attachment={attachment}
        draft={draft}
        replyEvent={replyEvent}
        replyError={replyError}
        available={available}
        unresolved={unresolved && mentionQuery === undefined}
        onRemoveRecipient={() => {
          setDraft((current) => ({
            ...current,
            recipient: { kind: 'channel' },
            recipientLabel: '',
            replyNeedsSelection: false,
          }));
          setEntrust(false);
          setResponseRequested(false);
        }}
      />
      <ComposerMessageQuotes draft={draft} setDraft={setDraft} />
      <ComposerRichContent draft={draft} setDraft={setDraft} expanded={expanded} />
      {expanded && (
        <ComposerTray
          files={files}
          channelId={channelId}
          voiceDevice={voice.device}
          onFiles={() => fileInput.current?.click()}
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
      <ComposerInput
        voice={voice}
        files={files}
        inputRef={inputRef}
        fileRef={fileInput}
        expanded={expanded}
        onExpand={() => setExpanded((value) => !value)}
        disabled={disabled}
        input={{
          id: inputId,
          value: draft.body,
          placeholder: inputPlaceholder,
          'aria-label': inputPlaceholder,
          'aria-autocomplete': 'list',
          required: !hasComposerContextContent(draft),
          'aria-controls': mentionQuery !== undefined ? listId : undefined,
          'aria-activedescendant':
            mentionQuery !== undefined && options.length ? `${listId}-${activeIndex}` : undefined,
          onKeyDown: keyDown,
          onChange(event) {
            const body = event.target.value;
            setDraft((current) => ({ ...current, body }));
            const match = body.slice(0, event.target.selectionStart).match(/(?:^|\s)@([^\s@]*)$/u);
            setMentionQuery(match?.[1]);
            setActiveOption(0);
          },
        }}
      />
      <ComposerFeedback
        durable={durable}
        fileNotice={files.notice}
        storageNotice={storageNotice}
        mixedAttachmentAction={mixedAttachmentAction}
        delivery={delivery}
      />
    </form>
  );
}
