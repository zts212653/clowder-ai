import type { SharedMarkdownView } from './collective-artifact-client.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { SharedArtifactAnnotationThread } from './SharedArtifactAnnotationThread.js';
import { useSharedArtifactReading } from './SharedArtifactReading.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';
import { useSharedArtifactAnnotationPages } from './use-shared-artifact-annotation-pages.js';

export function SharedArtifactAnnotations({
  view: initial,
  onOpenDiscussion,
}: {
  readonly view: SharedMarkdownView;
  readonly onOpenDiscussion: () => void;
}) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const shared = useSharedArtifacts();
  const reading = useSharedArtifactReading();
  const artifact = shared?.catalogue.find((item) => item.contentRef === initial.contentRef);
  const pages = useSharedArtifactAnnotationPages(artifact, initial);
  const view = pages.view;
  if (!view.view.review.annotations.length) return null;
  return (
    <aside className="shared-artifact-annotations" aria-label={t('作品批注')}>
      <h2>
        {t('批注')} · {view.view.annotationPage?.total ?? view.view.review.annotations.length}
      </h2>
      {view.view.review.annotations.map((annotation, index) => {
        const status = view.view.annotationResolutions?.find((item) => item.annotationId === annotation.id)?.status;
        const source = annotation.collectiveMessage;
        const original = source?.ownerRevision;
        const orphaned = status === 'orphaned' || status === 'ambiguous';
        return (
          <article key={annotation.id}>
            <header>
              <strong>
                {index + 1} · {shared?.humanName(annotation.author.actorId) ?? t('共同体成员')}
              </strong>
              <span>{t(annotation.state === 'resolved' ? '已解决' : '批注')}</span>
            </header>
            {'quote' in annotation.anchor && <blockquote>{annotation.anchor.quote}</blockquote>}
            <MessageMarkdown source={annotation.body} />
            <div className="shared-artifact-annotation-links">
              {original && artifact && (
                <button type="button" onClick={() => shared?.open(artifact, original)}>
                  {orphaned ? `${t('原文已改')} · ` : ''}
                  {language === 'en' ? `View in version ${original}` : `在第 ${original} 版查看`}
                </button>
              )}
              {artifact && source && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      shared?.close();
                      shared?.returnToSource?.(source.channelId, source.eventId);
                    }}
                  >
                    {t('在原讨论查看')}
                  </button>
                  {view.view.canReply && (
                    <button
                      type="button"
                      onClick={() => {
                        shared?.open(artifact, source.ownerRevision);
                        reading?.setReply({
                          artifactId: artifact.artifactId,
                          ownerRevision: source.ownerRevision,
                          blobDigest: source.blobDigest,
                          annotationId: annotation.id,
                          messageEventId: source.eventId,
                          authorHumanId: annotation.author.actorId,
                        });
                        onOpenDiscussion();
                      }}
                    >
                      {t('在原讨论回复')}
                    </button>
                  )}
                </>
              )}
            </div>
            {artifact && <SharedArtifactAnnotationThread artifact={artifact} view={view} annotation={annotation} />}
          </article>
        );
      })}
      {view.view.annotationPage?.nextOffset !== undefined && (
        <button type="button" disabled={pages.pending} onClick={() => void pages.more()}>
          {pages.pending
            ? t('正在读取…')
            : language === 'en'
              ? `More annotations (${view.view.review.annotations.length}/${view.view.annotationPage.total})`
              : `更多批注（${view.view.review.annotations.length}/${view.view.annotationPage.total}）`}
        </button>
      )}
      {pages.error && <p role="alert">{t(pages.error)}</p>}
    </aside>
  );
}
