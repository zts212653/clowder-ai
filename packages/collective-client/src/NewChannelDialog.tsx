import {
  type CollectiveChannelCreateResponse,
  collectiveChannelNameIssue,
  collectiveChannelNameKey,
  normalizeCollectiveChannelName,
} from '@cat-cafe/shared';
import { useId, useRef, useState } from 'react';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { MaterialDialogFrame } from './MaterialDialogFrame.js';
import {
  ChannelDialogFooter,
  ChannelNameFeedback,
  channelFailurePhase,
  isTerminalSubmissionPhase,
  SubmissionFeedback,
  type SubmissionPhase,
} from './NewChannelDialogFeedback.js';

export function NewChannelDialog({
  collectiveName,
  channels,
  create,
  onCreated,
  onSelect,
  onClose,
}: {
  readonly collectiveName: string;
  readonly channels: readonly string[];
  readonly create: (name: string, clientOperationId: string) => Promise<CollectiveChannelCreateResponse | undefined>;
  readonly onCreated: (channelId: string) => void;
  readonly onSelect: (channelId: string) => void;
  readonly onClose: () => void;
}) {
  const t = useCollectiveText();
  const language = useCollectiveLanguage();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef<{ readonly name: string; readonly id: string }>();
  const [name, setName] = useState('');
  const [phase, setPhase] = useState<SubmissionPhase>('idle');
  const [serviceExisting, setServiceExisting] = useState<string>();
  const normalized = normalizeCollectiveChannelName(name);
  const issue = collectiveChannelNameIssue(name);
  const localExisting = channels.find(
    (channelId) => collectiveChannelNameKey(channelId) === collectiveChannelNameKey(normalized),
  );
  const existing = serviceExisting ?? localExisting;
  const terminalFailure = isTerminalSubmissionPhase(phase);

  const submit = async () => {
    if (issue || existing || phase === 'submitting' || terminalFailure) return;
    if (!operation.current || operation.current.name !== normalized) {
      operation.current = { name: normalized, id: crypto.randomUUID() };
    }
    setPhase('submitting');
    try {
      const result = await create(normalized, operation.current.id);
      if (!result) return;
      if (result.status === 'existing') {
        setServiceExisting(result.channel.channelId);
        setPhase('idle');
        return;
      }
      onCreated(result.channel.channelId);
    } catch (error) {
      setPhase(channelFailurePhase(error));
    }
  };

  return (
    <MaterialDialogFrame
      label={t('新建频道')}
      className="new-channel-dialog"
      busy={phase === 'submitting'}
      initialFocusRef={input}
      onClose={onClose}
    >
      <header>
        <h2>{t('新建频道')}</h2>
        <button type="button" aria-label={t('关闭')} disabled={phase === 'submitting'} onClick={onClose}>
          ×
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={inputId}>{t('频道名')}</label>
        <div className="new-channel-name" data-invalid={Boolean((issue && issue !== 'empty') || existing)}>
          <span aria-hidden="true">#</span>
          <input
            ref={input}
            id={inputId}
            aria-label={t('频道名')}
            placeholder={t('比如 发布节奏')}
            value={name}
            disabled={phase === 'submitting' || terminalFailure}
            onChange={(event) => {
              setName(event.target.value);
              setServiceExisting(undefined);
              if (phase === 'failed') setPhase('idle');
            }}
          />
        </div>
        <ChannelNameFeedback existing={existing} issue={issue} onSelect={onSelect} onClose={onClose} />
        <p className="new-channel-visibility">
          <strong>{t('公开')}</strong>
          {language === 'en'
            ? ` · Everyone in ${collectiveName} can view and post.`
            : `：${collectiveName}的成员都能看到、都能发言`}
        </p>
        <SubmissionFeedback phase={phase} language={language} collectiveName={collectiveName} />
        <ChannelDialogFooter phase={phase} createDisabled={Boolean(issue || existing)} onClose={onClose} />
      </form>
    </MaterialDialogFrame>
  );
}
