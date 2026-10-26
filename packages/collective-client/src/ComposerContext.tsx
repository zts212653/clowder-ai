import { actorDisplayName } from './channel-model.js';
import type { CollectiveEventEnvelope } from './client-types.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import type { ComposerDraft } from './composer-draft.js';
import { SharedArtifactQuoteTags } from './SharedArtifactQuoteTags.js';
import type { useSharedArtifactComposer } from './use-shared-artifact-composer.js';

export function ComposerContext({
  attachment,
  draft,
  replyEvent,
  replyError,
  available,
  unresolved,
  onRemoveRecipient,
}: {
  readonly attachment: ReturnType<typeof useSharedArtifactComposer>;
  readonly draft: ComposerDraft;
  readonly replyEvent?: CollectiveEventEnvelope;
  readonly replyError?: string;
  readonly available: boolean;
  readonly unresolved: boolean;
  readonly onRemoveRecipient: () => void;
}) {
  const language = useCollectiveLanguage(),
    t = useCollectiveText();
  return (
    <>
      <SharedArtifactQuoteTags attachment={attachment} />
      {replyEvent && (
        <div className="composer-recipient" role="group" aria-label={t('回复来源')}>
          <span>
            {language === 'en' ? 'Reply to' : '回复'} {actorDisplayName(replyEvent)}
            {language === 'en' ? ': ' : '：'}
            {replyEvent.body.replace(/\s+/gu, ' ').slice(0, 60)}
          </span>
        </div>
      )}
      {draft.recipient.kind !== 'channel' && (
        <div className="composer-recipient">
          <span>@{draft.recipientLabel || t('已选成员')}</span>
          <button type="button" aria-label={t('移除 @')} onClick={onRemoveRecipient}>
            ×
          </button>
        </div>
      )}
      {(replyError || !available) && (
        <p role="alert" className="composer-warning">
          {replyError ? t(replyError) : t('参与设置已变化，请重新选择成员；消息尚未发送。')}
        </p>
      )}
      {unresolved && (
        <p role="alert" className="composer-warning">
          {t('请用 @ 选择当前频道的成员，或移除没选中的 @。')}
        </p>
      )}
    </>
  );
}
