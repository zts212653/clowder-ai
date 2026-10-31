import type { DeliveryState } from './client-types.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import type { useServiceComposerDraft } from './use-service-composer-draft.js';

export function ComposerFeedback({
  durable,
  fileNotice,
  storageNotice,
  mixedAttachmentAction,
  delivery,
}: {
  readonly durable: Pick<ReturnType<typeof useServiceComposerDraft>, 'conflict' | 'notice' | 'useRemote' | 'keepLocal'>;
  readonly fileNotice?: string;
  readonly storageNotice?: string;
  readonly mixedAttachmentAction: boolean;
  readonly delivery: DeliveryState;
}) {
  const language = useCollectiveLanguage(),
    t = useCollectiveText();
  return (
    <div className="composer-feedback">
      {durable.conflict && (
        <div className="composer-warning" role="alert">
          <p>
            {language === 'en'
              ? 'Another window saved a different draft. Both versions are kept.'
              : '另一窗口保存了不同的草稿，两份内容都已保留。'}
          </p>
          <blockquote>{durable.conflict.content.body}</blockquote>
          <button type="button" onClick={durable.useRemote}>
            {language === 'en' ? 'Load saved draft' : '载入保存的草稿'}
          </button>
          <button type="button" onClick={durable.keepLocal}>
            {language === 'en' ? 'Keep this draft' : '保留当前草稿'}
          </button>
        </div>
      )}
      {durable.notice && <output className="composer-warning">{durable.notice}</output>}
      {fileNotice && <output className="composer-warning">{fileNotice}</output>}
      {mixedAttachmentAction && (
        <output className="composer-warning">
          {language === 'en'
            ? 'Keep this attachment in a separate message from the artwork action.'
            : '作品操作与普通附件请分开发送，草稿均已保留。'}
        </output>
      )}
      {storageNotice && <output className="composer-warning">{t(storageNotice)}</output>}
      {delivery.kind !== 'idle' && (
        <output className={`delivery-state delivery-${delivery.kind}`}>{t(delivery.label)}</output>
      )}
    </div>
  );
}
