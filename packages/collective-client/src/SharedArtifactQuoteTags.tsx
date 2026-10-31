import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import type { useSharedArtifactComposer } from './use-shared-artifact-composer.js';

export function SharedArtifactQuoteTags({
  attachment,
}: {
  readonly attachment: ReturnType<typeof useSharedArtifactComposer>;
}) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  if (!attachment.selections.length && !attachment.rework && !attachment.reply && !attachment.failure) return null;
  return (
    <fieldset className="shared-artifact-quote-tags" aria-label={t('作品引用')}>
      {attachment.reply && (
        <div>
          <span>
            {language === 'en'
              ? `Reply to an annotation on version ${attachment.reply.ownerRevision} · keep in the original discussion`
              : `回复第 ${attachment.reply.ownerRevision} 版的批注 · 留在原讨论`}
          </span>
          <button type="button" aria-label={t('移除批注引用')} onClick={attachment.removeReply}>
            ×
          </button>
        </div>
      )}
      {attachment.rework && (
        <div>
          <span>
            {language === 'en'
              ? `Changes for version ${attachment.rework.sourceOwnerRevision} · redo from version ${attachment.rework.ownerRevision}`
              : `第 ${attachment.rework.sourceOwnerRevision} 版的修改 · 基于第 ${attachment.rework.ownerRevision} 版重做`}
          </span>
          <button type="button" aria-label={t('移除修改引用')} onClick={attachment.removeRework}>
            ×
          </button>
        </div>
      )}
      {attachment.selections.map((selection, index) => (
        <div key={`${selection.artifactId}:${selection.span.start}:${index}`}>
          <span>
            {index + 1} ·{' '}
            {language === 'en' ? `Version ${selection.ownerRevision}` : `第 ${selection.ownerRevision} 版`} ·{' '}
            {attachment.label(index)}
          </span>
          <button
            type="button"
            aria-label={language === 'en' ? `Remove reference ${index + 1}` : `移除引用 ${index + 1}`}
            onClick={() => attachment.remove(index)}
          >
            ×
          </button>
        </div>
      ))}
      {(attachment.stale || attachment.failure) && (
        <p role="alert">
          {t(attachment.stale ? '引用的版本已改变或无法访问，请重新选取；你写的话仍在。' : (attachment.failure ?? ''))}
        </p>
      )}
    </fieldset>
  );
}
