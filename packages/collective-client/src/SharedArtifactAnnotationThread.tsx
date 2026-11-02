import { useRef, useState } from 'react';
import type { SharedArtifact, SharedMarkdownView } from './collective-artifact-client.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

type Annotation = SharedMarkdownView['view']['review']['annotations'][number];
export function SharedArtifactAnnotationThread({
  artifact,
  view,
  annotation,
}: {
  readonly artifact: SharedArtifact;
  readonly view: SharedMarkdownView;
  readonly annotation: Annotation;
}) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const shared = useSharedArtifacts();
  const key = JSON.stringify([
    artifact.serviceInstanceId,
    artifact.collectiveId,
    artifact.artifactId,
    shared?.humanId,
    view.ownerRevision,
    view.view.review.revision,
    annotation.id,
  ]);
  const current = useRef(key);
  current.current = key;
  const [loaded, setLoaded] = useState<{
    key: string;
    replies: NonNullable<Annotation['replies']>;
    total: number;
    nextOffset?: number;
  }>();
  const [pending, setPending] = useState<string>();
  const [settled, setSettled] = useState<string>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const page = view.view.replyPages?.find((item) => item.annotationId === annotation.id);
  const replies = loaded?.key === key ? loaded.replies : (annotation.replies ?? []);
  const total = page?.total ?? replies.length;
  const offset = loaded?.key === key ? loaded.nextOffset : page?.nextOffset;
  const blocked = pending === key || settled === key;
  const more = async () => {
    if (!shared?.api || offset === undefined || blocked) return;
    setPending(key);
    setFailure(undefined);
    try {
      const result = await shared.api.moreReplies(artifact, view, annotation.id, offset);
      if (current.current !== key) return;
      if (result.replies.some((reply) => replies.some((existing) => existing.id === reply.id)))
        throw new Error('批注回复正在更新，请重新读取。');
      setLoaded({ key, replies: [...replies, ...result.replies], total: result.total, nextOffset: result.nextOffset });
    } catch {
      if (current.current === key) setFailure({ key, message: '回复暂时读不到，请重新读取作品后重试。' });
    } finally {
      if (current.current === key) setPending(undefined);
    }
  };
  const decide = async () => {
    if (!shared?.api || !shared.humanId || blocked) return;
    setPending(key);
    setFailure(undefined);
    try {
      await shared.api.setAnnotationState({
        artifact,
        view,
        annotationId: annotation.id,
        state: annotation.state === 'open' ? 'resolved' : 'open',
        humanId: shared.humanId,
      });
      if (current.current === key) setSettled(key);
      await shared.refresh();
    } catch {
      if (current.current === key) setFailure({ key, message: '决定尚未确认，请重试原操作或重新读取作品。' });
    } finally {
      if (current.current === key) setPending(undefined);
    }
  };
  return (
    <div className="shared-artifact-annotation-thread">
      {replies.map((reply) => (
        <div key={reply.id} className="shared-artifact-annotation-reply">
          <strong>{shared?.humanName(reply.author.actorId)}</strong>
          <MessageMarkdown source={reply.body} />
        </div>
      ))}
      {offset !== undefined && (
        <button type="button" disabled={blocked} onClick={() => void more()}>
          {language === 'en' ? `Load replies (${replies.length}/${total})` : `读取回复（${replies.length}/${total}）`}
        </button>
      )}
      {view.view.canWrite && (
        <button type="button" disabled={blocked} onClick={() => void decide()}>
          {t(annotation.state === 'open' ? '解决批注' : '重新打开批注')}
        </button>
      )}
      {settled === key && <output>{t('正在同步批注…')}</output>}
      {failure?.key === key && <p role="alert">{t(failure.message)}</p>}
    </div>
  );
}
