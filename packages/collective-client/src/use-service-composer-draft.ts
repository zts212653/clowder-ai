import { type CollectiveComposerDraft, collectiveComposerDraftSchema } from '@cat-cafe/shared';
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import type { ComposerDraft } from './composer-draft.js';
import { emptyDraft } from './composer-draft.js';
import { acknowledgeHumanSend } from './human-send-custody.js';
import { type MessageExpressionPort, useMessageExpression } from './message-expression-context.js';
import { discardPendingAttachmentFiles } from './pending-attachment-files.js';

const fingerprint = (draft: ComposerDraft) => {
  const parsed = collectiveComposerDraftSchema.safeParse(draft);
  if (!parsed.success) return JSON.stringify(draft);
  return JSON.stringify(
    collectiveComposerDraftSchema.parse({
      ...parsed.data,
      attachments: parsed.data.attachments?.length ? parsed.data.attachments : undefined,
      entrust: Boolean(parsed.data.entrust),
      responseRequested: Boolean(parsed.data.responseRequested),
      replyNeedsSelection: Boolean(parsed.data.replyNeedsSelection),
    }),
  );
};
interface SavedDraft {
  revision: number;
  fingerprint: string;
  clientOperationId?: string;
  consumedFingerprint?: string;
  consumedAttachmentIds?: string[];
}

/** Local edits stay immediate; the Service owns versions, concurrency and atomic send consumption. */
export function useServiceComposerDraft(input: {
  draftKey: string;
  namespace: string;
  channelId: string;
  rootEventId?: string;
  draft: ComposerDraft;
  setDraft: Dispatch<SetStateAction<ComposerDraft>>;
  paused: boolean;
}) {
  const port = useMessageExpression();
  const [ready, setReady] = useState(!port);
  const [notice, setNotice] = useState<string>();
  const [conflict, setConflict] = useState<{ revision: number; content: CollectiveComposerDraft }>();
  const base = useRef<SavedDraft>({ revision: 0, fingerprint: fingerprint(emptyDraft) });
  const current = useRef(input);
  current.current = input;
  const currentConflict = useRef(conflict);
  currentConflict.current = conflict;
  const pending = useRef<Promise<SavedDraft>>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const active = useRef(true);
  const metadataKey = `${input.draftKey}:service-version`;
  const remember = useCallback(
    (saved: SavedDraft) => {
      base.current = saved;
      try {
        localStorage.setItem(metadataKey, JSON.stringify(saved));
      } catch {
        if (active.current) setNotice('浏览器未能保存草稿版本；服务器草稿仍在。');
      }
    },
    [metadataKey],
  );
  useEffect(() => {
    active.current = true;
    if (!port) return;
    let cancelled = false;
    const baseline = fingerprint(current.current.draft);
    void port
      .channelState(input.channelId, input.rootEventId)
      .then(async (remote) => {
        if (cancelled) return;
        const fresh = fingerprint(current.current.draft),
          remoteFingerprint = fingerprint(remote.draft.content);
        let cached: SavedDraft | undefined;
        try {
          cached = JSON.parse(localStorage.getItem(metadataKey) ?? 'null') ?? undefined;
        } catch {
          /* No receipt. */
        }
        const consumed =
          remote.draft.clientOperationId?.startsWith('sent:') &&
          cached &&
          ((cached.fingerprint === fresh && remote.draft.revision === cached.revision + 1) ||
            (cached.consumedFingerprint === fresh && cached.clientOperationId === remote.draft.clientOperationId));
        const consumedAttachmentIds = consumed
          ? (current.current.draft.attachments?.map((item) => item.attachmentId) ?? [])
          : remote.draft.clientOperationId === cached?.clientOperationId
            ? (cached?.consumedAttachmentIds ?? [])
            : [];
        if (consumedAttachmentIds.length) {
          await discardPendingAttachmentFiles(input.draftKey, consumedAttachmentIds);
          if (cancelled) return;
        }
        if (consumed) {
          acknowledgeHumanSend(localStorage, input.namespace, remote.draft.clientOperationId!.slice(5));
          current.current.setDraft(remote.draft.content);
        } else if (fresh === baseline && fresh === fingerprint(emptyDraft)) {
          current.current.setDraft(remote.draft.content);
        } else if (
          fresh !== remoteFingerprint &&
          remote.draft.revision > 0 &&
          cached?.revision !== remote.draft.revision
        ) {
          setConflict({ revision: remote.draft.revision, content: remote.draft.content });
        }
        remember({
          revision: remote.draft.revision,
          fingerprint: remoteFingerprint,
          clientOperationId: remote.draft.clientOperationId,
          ...(consumed ? { consumedFingerprint: fresh } : {}),
          ...(consumedAttachmentIds.length ? { consumedAttachmentIds } : {}),
        });
        setReady(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : String(error));
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
      active.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [port, input.draftKey, input.channelId, input.rootEventId, input.namespace, metadataKey, remember]);

  const persist = async (draft: ComposerDraft, keepalive = false): Promise<SavedDraft> => {
    if (!port) return base.current;
    while (pending.current) await pending.current;
    if (currentConflict.current) throw new Error('另一窗口已更新草稿，请先选择要保留的内容。');
    const content = collectiveComposerDraftSchema.parse(draft),
      serialized = fingerprint(content);
    if (serialized === base.current.fingerprint && base.current.revision > 0) return base.current;
    const clientOperationId = crypto.randomUUID(),
      expectedRevision = base.current.revision;
    const operation = (async () => {
      const result = await port.saveDraft(
        input.channelId,
        input.rootEventId,
        content,
        expectedRevision,
        clientOperationId,
        keepalive,
      );
      if (result.status === 'conflict') {
        currentConflict.current = { revision: result.draft.revision, content: result.draft.content };
        if (active.current) setConflict(currentConflict.current);
        throw new Error('另一窗口已更新草稿；两份内容都已保留。');
      }
      const saved = { revision: result.draft.revision, fingerprint: serialized, clientOperationId };
      remember(saved);
      if (active.current) setNotice(undefined);
      return saved;
    })();
    pending.current = operation;
    try {
      return await operation;
    } finally {
      if (pending.current === operation) pending.current = undefined;
    }
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const serialized = fingerprint(input.draft);
  useEffect(() => {
    if (!port || !ready || conflict || input.paused || serialized === base.current.fingerprint) return;
    timer.current = setTimeout(() => {
      void persistRef.current(current.current.draft).catch((error) => {
        if (active.current) setNotice(error instanceof Error ? error.message : String(error));
      });
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [serialized, ready, conflict, input.paused, port]);
  useEffect(() => {
    const pageExit = () => {
      if (
        !port ||
        !ready ||
        currentConflict.current ||
        current.current.paused ||
        fingerprint(current.current.draft) === base.current.fingerprint
      )
        return;
      void persistRef.current(current.current.draft, true).catch(() => {});
    };
    window.addEventListener('pagehide', pageExit);
    return () => {
      window.removeEventListener('pagehide', pageExit);
      pageExit();
    };
  }, [ready, port]);
  return {
    ready,
    conflict,
    notice,
    acceptExternal(result: Awaited<ReturnType<MessageExpressionPort['saveDraft']>>) {
      if (result.status === 'conflict') {
        currentConflict.current = { revision: result.draft.revision, content: result.draft.content };
        if (active.current) setConflict(currentConflict.current);
        return;
      }
      remember({
        revision: result.draft.revision,
        fingerprint: fingerprint(result.draft.content),
        clientOperationId: result.draft.clientOperationId,
      });
    },
    async flush(draft: ComposerDraft) {
      if (timer.current) clearTimeout(timer.current);
      const saved = await persistRef.current(draft);
      return saved.revision
        ? { revision: saved.revision, ...(input.rootEventId ? { rootEventId: input.rootEventId } : {}) }
        : undefined;
    },
    async acknowledged(sent: ComposerDraft) {
      if (!port) return true;
      let remote: Awaited<ReturnType<MessageExpressionPort['channelState']>>;
      try {
        remote = await port.channelState(input.channelId, input.rootEventId);
      } catch {
        setNotice('消息已发送，草稿同步暂不可用；请勿重复发送。');
        return true;
      }
      const remoteFingerprint = fingerprint(remote.draft.content);
      if (fingerprint(remote.draft.content) === fingerprint(emptyDraft)) {
        remember({
          revision: remote.draft.revision,
          fingerprint: remoteFingerprint,
          clientOperationId: remote.draft.clientOperationId,
          consumedFingerprint: fingerprint(sent),
          consumedAttachmentIds: sent.attachments?.map((item) => item.attachmentId) ?? [],
        });
        return true;
      }
      if (fingerprint(current.current.draft) === fingerprint(sent)) {
        currentConflict.current = { revision: remote.draft.revision, content: remote.draft.content };
        setConflict(currentConflict.current);
      }
      return false;
    },
    async clearAfterAction(sent: ComposerDraft) {
      if (fingerprint(current.current.draft) !== fingerprint(sent)) return false;
      try {
        await persistRef.current(emptyDraft);
        return true;
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    useRemote() {
      if (!conflict) return;
      remember({ revision: conflict.revision, fingerprint: fingerprint(conflict.content) });
      input.setDraft(conflict.content);
      currentConflict.current = undefined;
      setConflict(undefined);
      setNotice(undefined);
    },
    keepLocal() {
      if (!conflict) return;
      remember({ revision: conflict.revision, fingerprint: fingerprint(conflict.content) });
      currentConflict.current = undefined;
      setConflict(undefined);
      setNotice(undefined);
      void persistRef.current(current.current.draft).catch((error) => setNotice(String(error)));
    },
  };
}
