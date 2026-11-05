import { useRef, useState } from 'react';
import type { SharedArtifact, SharedMarkdownView } from './collective-artifact-client.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

/** Earlier pages are an explicit reader choice; regular polling never fetches the whole journal. */
export function useSharedArtifactRequestHistory(artifact: SharedArtifact | undefined, view: SharedMarkdownView) {
  const shared = useSharedArtifacts();
  const fence = JSON.stringify([
    artifact?.artifactId,
    artifact?.accessRevision,
    view.ownerRevision,
    view.blobDigest,
    view.view.review.revision,
    view.modifications?.snapshot,
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
      const next = await shared.api.moreRequests(artifact, selected);
      if (current.current === fence) setExpanded({ fence, view: next });
    } catch {
      if (current.current === fence) setFailure({ fence, message: '修改记录正在更新或暂时不可读，请重新读取。' });
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
