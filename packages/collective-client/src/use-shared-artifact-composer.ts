import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import type { CollectiveRecipient } from './client-types.js';
import type { ComposerDraft } from './composer-draft.js';
import { useSharedArtifactReading } from './SharedArtifactReading.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

/** Shares the Topic's draft and send path. Source references never create a second composer or automatic send. */
export function useSharedArtifactComposer(
  draft: ComposerDraft,
  setDraft: Dispatch<SetStateAction<ComposerDraft>>,
  rootEventId?: string,
) {
  const shared = useSharedArtifacts();
  const reading = useSharedArtifactReading();
  const quote = reading?.quote;
  const artifact = reading?.artifact;
  const view = reading?.view;
  const pendingRework = reading?.rework;
  const pendingReply = reading?.reply;
  const active = Boolean(artifact && rootEventId === (artifact.sourceLocation.rootEventId ?? artifact.sourceEventId));
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    if (!active || !pendingReply || pendingReply.artifactId !== artifact?.artifactId) return;
    setDraft((current) => ({
      ...current,
      artifactSelections: undefined,
      artifactRework: undefined,
      artifactReply: pendingReply,
      recipient: { kind: 'human', humanId: pendingReply.authorHumanId },
      recipientLabel: shared?.humanName(pendingReply.authorHumanId) ?? '',
      replyToEventId: pendingReply.messageEventId,
      replyNeedsSelection: false,
    }));
    reading?.setReply(undefined);
    reading?.setQuote(undefined);
    reading?.setRework(undefined);
  }, [
    active,
    pendingReply,
    artifact?.artifactId,
    reading?.setReply,
    reading?.setQuote,
    reading?.setRework,
    setDraft,
    shared?.humanName,
  ]);
  useEffect(() => {
    if (!active || !pendingRework || pendingRework.artifactId !== artifact?.artifactId) return;
    const { recipient, label, ...reference } = pendingRework;
    setDraft((current) => ({
      ...current,
      body: [current.body, `基于第 ${reference.ownerRevision} 版重做这一处。`].filter(Boolean).join('\n'),
      artifactSelections: undefined,
      artifactReply: undefined,
      artifactRework: reference,
      recipient: recipient ?? { kind: 'channel' },
      recipientLabel: label ?? '',
      replyToEventId: undefined,
      replyNeedsSelection: !recipient,
    }));
    reading?.setRework(undefined);
    reading?.setQuote(undefined);
  }, [active, pendingRework, artifact?.artifactId, reading?.setRework, reading?.setQuote, setDraft]);
  useEffect(() => {
    if (!active || !quote || !view || quote.artifactId !== artifact?.artifactId || quote.blobDigest !== view.blobDigest)
      return;
    setDraft((current) => {
      const selections = current.artifactSelections ?? [];
      if (selections.some((item) => JSON.stringify(item) === JSON.stringify(quote))) return current;
      return {
        ...current,
        artifactReply: undefined,
        artifactRework: undefined,
        artifactSelections: [...selections, quote].slice(0, 12),
      };
    });
    reading?.setQuote(undefined);
  }, [active, quote, view, artifact?.artifactId, reading?.setQuote, setDraft]);
  useEffect(() => {
    if (
      !reading?.inaccessible ||
      !shared?.selected ||
      (!draft.artifactSelections?.some((selection) => selection.artifactId === shared.selected?.artifactId) &&
        draft.artifactRework?.artifactId !== shared.selected?.artifactId &&
        draft.artifactReply?.artifactId !== shared.selected?.artifactId)
    )
      return;
    setDraft((current) => ({
      ...current,
      artifactSelections: undefined,
      artifactRework: undefined,
      artifactReply: undefined,
    }));
    reading.setQuote(undefined);
    reading.setRework(undefined);
    reading.setReply(undefined);
  }, [
    reading?.inaccessible,
    shared?.selected,
    draft.artifactSelections,
    draft.artifactRework,
    draft.artifactReply,
    reading?.setQuote,
    reading?.setRework,
    reading?.setReply,
    setDraft,
  ]);
  const selections = draft.artifactSelections ?? [];
  const rework = draft.artifactRework;
  const reply = draft.artifactReply;
  const references = reply ? [reply] : rework ? [rework] : selections;
  const stale =
    references.length > 0 &&
    (!active ||
      !view ||
      (reply ? !view.view.canReply : !view.view.canWrite) ||
      references.some(
        (selection) =>
          selection.artifactId !== artifact?.artifactId ||
          selection.ownerRevision !== view.ownerRevision ||
          selection.blobDigest !== view.blobDigest,
      ));
  const send = async (body: string, recipient: CollectiveRecipient) => {
    if (!shared?.api || !artifact || !view || stale) throw new Error('引用已不可用，请重新选择；草稿已保留。');
    try {
      setFailure(undefined);
      if (reply) {
        if (!shared.humanId) throw new Error('成员身份暂时不可用。');
        await shared.api.sendReply({ artifact, view, reply, body, recipient, humanId: shared.humanId });
      } else
        await shared.api.sendFeedback({
          artifact,
          view,
          selections,
          body,
          recipient,
          ...(rework ? { rework: rework.rework } : {}),
        });
      setDraft((current) => {
        if (
          current.body.trim() !== body ||
          current.recipient !== recipient ||
          current.artifactReply !== reply ||
          current.artifactRework !== rework ||
          current.artifactSelections !== draft.artifactSelections
        )
          return current;
        return { ...current, artifactSelections: undefined, artifactRework: undefined, artifactReply: undefined };
      });
      await shared.refresh();
      await shared.refreshDiscussion?.();
    } catch {
      setFailure('反馈尚未确认，草稿已保留。重试会沿用同一条消息。');
      throw new Error('反馈尚未确认');
    }
  };
  return {
    selections,
    rework,
    reply,
    removeReply: () => setDraft((current) => ({ ...current, artifactReply: undefined })),
    removeRework: () => setDraft((current) => ({ ...current, artifactRework: undefined })),
    stale,
    failure,
    send,
    remove: (index: number) =>
      setDraft((current) => ({
        ...current,
        artifactSelections: current.artifactSelections?.filter((_, at) => at !== index),
      })),
    label: (index: number) => {
      const selection = selections[index];
      return selection && active && view?.blobDigest === selection.blobDigest
        ? view.text.slice(selection.span.start, selection.span.end)
        : '引用的作品暂时不可用';
    },
  };
}
