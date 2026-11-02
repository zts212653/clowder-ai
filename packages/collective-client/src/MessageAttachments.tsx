import type { CollectiveMessageAttachment } from '@cat-cafe/shared';
import { collectiveRichMediaReferences, findMessageSticker } from '@cat-cafe/shared';
import {
  AudioPlayer,
  FileSummary,
  formatAttachmentSize,
  MediaThumbnail,
  MessageMediaViewer,
  markdownImageReferences,
  StickerArtwork,
} from '@cat-cafe/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { actorDisplayName, formatEventTime } from './channel-model.js';
import type { CollectiveEventEnvelope } from './client-types.js';
import { useCollectiveLanguage } from './collective-copy.js';
import { useMessageExpression } from './message-expression-context.js';

export function MessageAttachment({
  attachment,
  event,
  inline = false,
  imageDescription,
}: {
  attachment: CollectiveMessageAttachment;
  event: CollectiveEventEnvelope;
  inline?: boolean;
  imageDescription?: string;
}) {
  const port = useMessageExpression();
  const language = useCollectiveLanguage();
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [requested, setRequested] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLElement | null>(null);
  const Frame = inline ? 'span' : 'div';
  const image = /^image\/(png|jpeg|gif|webp)$/u.test(attachment.mediaType);
  const attachmentId = attachment.attachmentId;
  useEffect(() => {
    if (!image || !host.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRequested(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [image]);
  useEffect(() => {
    if (!requested || !port) return;
    const controller = new AbortController();
    let created: string | undefined;
    setLoading(true);
    setError(undefined);
    void port
      .read(attachmentId, event.eventId, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [requested, attempt, port, attachmentId, event.eventId]);
  const label = language === 'en' ? 'Open original' : '打开原图';
  const stickerLabel = attachment.sticker && findMessageSticker(attachment.sticker.stickerId)?.label[language];
  const returnToSource = () => {
    setOpen(false);
    const source = host.current?.closest<HTMLElement>('[data-event-id]');
    source?.scrollIntoView({ block: 'center' });
    source?.focus({ preventScroll: true });
  };
  return (
    <Frame
      ref={(node: HTMLElement | null) => {
        host.current = node;
      }}
      className={image ? 'message-image-attachment' : 'message-file-attachment'}
    >
      {image && url && stickerLabel ? (
        <StickerArtwork src={url} alt={stickerLabel} onOpen={() => setOpen(true)} />
      ) : image && url ? (
        <MediaThumbnail
          src={url}
          alt={imageDescription ?? attachment.fileName}
          label={`${label}：${imageDescription ?? attachment.fileName}`}
          onOpen={() => setOpen(true)}
        />
      ) : attachment.mediaType.startsWith('audio/') && url ? (
        <AudioPlayer url={url} label={attachment.fileName} />
      ) : attachment.mediaType.startsWith('video/') && url ? (
        <video src={url} controls preload="metadata" aria-label={attachment.fileName} />
      ) : url ? null : (
        <button
          type="button"
          disabled={loading || !port}
          onClick={() => {
            setRequested(true);
            setAttempt((value) => value + 1);
          }}
        >
          {attachment.fileName} · {formatAttachmentSize(attachment.byteLength)}{' '}
          {loading ? (language === 'en' ? 'Loading…' : '正在读取…') : ''}
        </button>
      )}
      {!image && url && (
        <FileSummary fileName={attachment.fileName} size={formatAttachmentSize(attachment.byteLength)}>
          {attachment.mediaType.startsWith('video/') && (
            <button type="button" onClick={() => setOpen(true)}>
              {language === 'en' ? 'Expand video' : '放大观看'}
            </button>
          )}
          <a href={url} download={attachment.fileName}>
            {language === 'en' ? 'Download' : '下载'} {attachment.fileName}
          </a>
        </FileSummary>
      )}
      {error && (
        <span role="status">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            {language === 'en' ? 'Retry' : '重试'}
          </button>
        </span>
      )}
      {open && url && (
        <MessageMediaViewer
          item={{ id: attachment.attachmentId, url, title: attachment.fileName, mediaType: attachment.mediaType }}
          title={`${actorDisplayName(event)} · #${event.location?.channelId ?? ''} · ${formatEventTime(event.acceptedAt, language)}`}
          onClose={() => setOpen(false)}
          onReturn={returnToSource}
          returnLabel={language === 'en' ? 'Back to message' : '回到原消息'}
          closeLabel={language === 'en' ? 'Close' : '关闭'}
        />
      )}
    </Frame>
  );
}

export function MessageAttachments({ event }: { readonly event: CollectiveEventEnvelope }) {
  const inlineImages = useMemo(() => {
    if (!event.attachments?.length) return new Set<string>();
    const sources = [
      event.body,
      ...(event.richBlocks?.flatMap((block) =>
        block.kind === 'card' && block.bodyMarkdown ? [block.bodyMarkdown] : [],
      ) ?? []),
    ];
    return new Set(sources.flatMap((source) => [...markdownImageReferences(source)]));
  }, [event.body, event.richBlocks, event.attachments]);
  if (!event.attachments?.length) return null;
  const richMedia = collectiveRichMediaReferences(event.richBlocks ?? []);
  return (
    <div className="message-attachments">
      {event.attachments
        .filter(
          (attachment) =>
            !richMedia.some((ref) => ref.url === attachment.contentRef) &&
            !(attachment.mediaType.startsWith('image/') && inlineImages.has(attachment.contentRef)),
        )
        .map((attachment) => (
          <MessageAttachment key={attachment.attachmentId} attachment={attachment} event={event} />
        ))}
    </div>
  );
}
