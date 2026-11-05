import type { CollectiveMessageAttachment, MessageSticker } from '@cat-cafe/shared';
import type { ComposerAttachmentItem } from '@cat-cafe/ui';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import type { ComposerDraft } from './composer-draft.js';
import { useMessageExpression } from './message-expression-context.js';
import {
  beginPendingAttachmentFile,
  discardPendingAttachmentFiles,
  pendingAttachmentFiles,
  savePendingAttachmentFile,
} from './pending-attachment-files.js';

interface UploadItem extends ComposerAttachmentItem {
  readonly file: File;
  readonly sticker?: MessageSticker;
}
export function useComposerAttachments(
  draftKey: string,
  channelId: string,
  draft: ComposerDraft,
  setDraft: Dispatch<SetStateAction<ComposerDraft>>,
  ready = true,
) {
  const port = useMessageExpression();
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>();
  const controllers = useRef(new Map<string, AbortController>());
  const active = useRef(true);
  const uploadUrls = useRef(new Set<string>());
  const present = useRef(new Set<string>());
  const currentDraft = useRef(draft);
  const uploadQueue = useRef(Promise.resolve());
  currentDraft.current = draft;

  const upload = async (item: UploadItem) => {
    if (!port || !active.current || !present.current.has(item.id) || controllers.current.has(item.id)) return;
    const controller = new AbortController();
    controllers.current.set(item.id, controller);
    setUploads((current) =>
      current.map((value) => (value.id === item.id ? { ...value, status: 'uploading', notice: undefined } : value)),
    );
    try {
      const attachment = await port.upload(item.file, item.id, channelId, controller.signal, item.sticker);
      if (!present.current.has(item.id)) return;
      await savePendingAttachmentFile(draftKey, {
        id: item.id,
        file: item.file,
        attachment,
        ...(item.sticker ? { sticker: item.sticker } : {}),
      });
      if (!present.current.has(item.id)) {
        await discardPendingAttachmentFiles(draftKey, [item.id]);
        return;
      }
      if (!active.current || !present.current.has(item.id)) return;
      setDraft((current) => ({ ...current, attachments: [...(current.attachments ?? []), attachment] }));
      setUploads((current) => current.filter((value) => value.id !== item.id));
      present.current.delete(item.id);
    } catch (error) {
      if (controller.signal.aborted || !active.current) return;
      setUploads((current) =>
        current.map((value) =>
          value.id === item.id
            ? { ...value, status: 'failed', notice: error instanceof Error ? error.message : String(error) }
            : value,
        ),
      );
    } finally {
      controllers.current.delete(item.id);
    }
  };
  // Preserve selection order and leave a Service upload slot available for the other member.
  const enqueueUpload = (item: UploadItem) => {
    uploadQueue.current = uploadQueue.current
      .then(() => upload(item))
      .catch((error) => {
        if (active.current) setNotice(error instanceof Error ? error.message : String(error));
      });
  };
  const add = async (files: readonly File[], sticker?: MessageSticker) => {
    if (!active.current) return;
    if (!port) {
      setNotice('附件服务当前不可用；文件尚未发送。');
      return;
    }
    const remaining = 12 - (currentDraft.current.attachments?.length ?? 0) - present.current.size;
    if (files.length > remaining) {
      setNotice('每条消息最多 12 个附件。');
      return;
    }
    for (const file of files) {
      if (!file.size || file.size > 50 * 1024 * 1024) {
        setNotice(`${file.name}：请选择 50 MiB 以内的非空文件。`);
        continue;
      }
      const id = crypto.randomUUID();
      const item: UploadItem = {
        id,
        file,
        name: file.name,
        mediaType: file.type,
        byteLength: file.size,
        url: URL.createObjectURL(file),
        status: 'uploading',
        ...(sticker ? { sticker } : {}),
      };
      uploadUrls.current.add(item.url!);
      present.current.add(id);
      setUploads((current) => [...current, item]);
      try {
        beginPendingAttachmentFile(draftKey, id);
        await savePendingAttachmentFile(draftKey, { id, file, ...(sticker ? { sticker } : {}) });
      } catch {
        setNotice('浏览器无法保存未上传的文件，请保留当前页面。');
      }
      if (!active.current) return;
      enqueueUpload(item);
    }
  };
  useEffect(() => {
    active.current = true;
    if (ready && port && typeof indexedDB !== 'undefined')
      void pendingAttachmentFiles(draftKey)
        .then((saved) => {
          if (!active.current) return;
          for (const item of saved) {
            if (item.attachment) {
              const attachment = item.attachment;
              setDraft((current) =>
                current.attachments?.some((value) => value.attachmentId === attachment.attachmentId)
                  ? current
                  : { ...current, attachments: [...(current.attachments ?? []), attachment] },
              );
              continue;
            }
            if (present.current.has(item.id)) continue;
            const uploadItem: UploadItem = {
              ...item,
              name: item.file.name,
              mediaType: item.file.type,
              byteLength: item.file.size,
              url: URL.createObjectURL(item.file),
              status: 'failed',
              notice: '上传未完成，重试后可继续发送。',
            };
            uploadUrls.current.add(uploadItem.url!);
            present.current.add(item.id);
            setUploads((current) => [...current, uploadItem]);
          }
        })
        .catch(() => setNotice('未能读取浏览器中的待上传文件。'));
    return () => {
      active.current = false;
      for (const controller of controllers.current.values()) controller.abort();
    };
  }, [draftKey, port, ready, setDraft]);
  useEffect(() => {
    const controller = new AbortController();
    const created: string[] = [];
    if (port)
      for (const item of draft.attachments ?? [])
        void port
          .read(item.attachmentId, undefined, controller.signal)
          .then((blob) => {
            if (controller.signal.aborted) return;
            const url = URL.createObjectURL(blob);
            created.push(url);
            setUrls((current) => ({ ...current, [item.attachmentId]: url }));
          })
          .catch(() => {
            if (!controller.signal.aborted) setNotice('附件暂时无法预览，已保留原引用。');
          });
    return () => {
      controller.abort();
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [draft.attachments, port]);
  useEffect(
    () => () => {
      for (const url of uploadUrls.current) URL.revokeObjectURL(url);
    },
    [],
  );
  const items: ComposerAttachmentItem[] = [
    ...(draft.attachments ?? []).map((item) => ({
      id: item.attachmentId,
      name: item.fileName,
      mediaType: item.mediaType,
      byteLength: item.byteLength,
      url: urls[item.attachmentId],
      status: 'ready' as const,
    })),
    ...uploads,
  ];
  return {
    items,
    notice,
    pending: uploads.length > 0,
    add,
    remove(id: string) {
      controllers.current.get(id)?.abort();
      present.current.delete(id);
      setUploads((current) => current.filter((item) => item.id !== id));
      setDraft((current) => ({
        ...current,
        attachments: current.attachments?.filter((item) => item.attachmentId !== id),
      }));
      void discardPendingAttachmentFiles(draftKey, [id]).catch(() => setNotice('未能移除本地文件，请重试。'));
    },
    retry(id: string) {
      const item = uploads.find((value) => value.id === id);
      if (item) enqueueUpload(item);
    },
    async confirm(attachments: readonly CollectiveMessageAttachment[]) {
      try {
        await discardPendingAttachmentFiles(
          draftKey,
          attachments.map((item) => item.attachmentId),
        );
      } catch {
        setNotice('消息已发送，本地文件缓存尚未清理；请勿重复发送。');
      }
    },
  };
}
