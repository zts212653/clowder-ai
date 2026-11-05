import { useRef, useState } from 'react';
import type { SharedArtifact, SharedMarkdownView } from './collective-artifact-client.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

/** Keep a reader's expanded cut across ordinary polls; a changed authority or ledger starts at page one. */
export function useSharedArtifactAnnotationPages(artifact: SharedArtifact | undefined, view: SharedMarkdownView) {
  const shared = useSharedArtifacts();
  const fence = JSON.stringify([
    artifact?.serviceInstanceId,
    artifact?.collectiveId,
    artifact?.artifactId,
    artifact?.accessRevision,
    shared?.humanId,
    view.contentRef,
    view.ownerRevision,
    view.blobDigest,
    view.view.review.reviewId,
    view.view.review.revision,
    view.view.annotationPage?.total,
    view.view.canWrite,
    view.view.canReply,
  ]);
  const current = useRef(fence);
  current.current = fence;
  const [expanded, setExpanded] = useState<{ fence: string; view: SharedMarkdownView }>();
  const [pending, setPending] = useState<string>();
  const [failure, setFailure] = useState<{ fence: string; message: string }>();
  const selected = expanded?.fence === fence ? expanded.view : view;
  const more = async () => {
    if (!shared?.api || !artifact || pending === fence) return;
    setPending(fence);
    setFailure(undefined);
    try {
      const next = await shared.api.moreAnnotations(artifact, selected);
      if (current.current === fence) setExpanded({ fence, view: next });
    } catch {
      if (current.current === fence) {
        setExpanded(undefined);
        setFailure({ fence, message: '批注正在更新或暂时不可读，请重新读取作品。' });
        await shared.refresh?.();
      }
    } finally {
      if (current.current === fence) setPending(undefined);
    }
  };
  return {
    view: selected,
    more,
    pending: pending === fence,
    error: failure?.fence === fence ? failure.message : undefined,
  };
}
