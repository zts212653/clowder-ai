import type { CollectiveMessageAttachment } from '@cat-cafe/shared';
import { formatAttachmentSize, MessageMediaViewer } from '@cat-cafe/ui';
import { useEffect, useRef, useState } from 'react';
import { actorDisplayName, formatEventTime } from './channel-model.js';
import type { CollectiveEventEnvelope } from './client-types.js';
import { useCollectiveLanguage } from './collective-copy.js';
import { useMessageExpression } from './message-expression-context.js';

function MessageAttachment({
  attachment,
  event,
}: {
  attachment: CollectiveMessageAttachment;
  event: CollectiveEventEnvelope;
}) {
  const port = useMessageExpression();
  const language = useCollectiveLanguage();
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [requested, setRequested] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
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
  const returnToSource = () => {
    setOpen(false);
    const source = document.getElementById(`collective-event-${event.eventId}`);
    source?.scrollIntoView({ block: 'center' });
    source?.focus({ preventScroll: true });
  };
  return (
    <div ref={host} className={image ? 'message-image-attachment' : 'message-file-attachment'}>
      {image && url ? (
        <button type="button" aria-label={`${label}：${attachment.fileName}`} onClick={() => setOpen(true)}>
          <img src={url} alt={attachment.fileName} loading="lazy" />
        </button>
      ) : attachment.mediaType.startsWith('audio/') && url ? (
        <audio src={url} controls preload="metadata" aria-label={attachment.fileName} />
      ) : attachment.mediaType.startsWith('video/') && url ? (
        <video src={url} controls preload="metadata" aria-label={attachment.fileName} />
      ) : (
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
        <a href={url} download={attachment.fileName}>
          {language === 'en' ? 'Download' : '下载'} {attachment.fileName}
        </a>
      )}
      {error && (
        <p role="status">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            {language === 'en' ? 'Retry' : '重试'}
          </button>
        </p>
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
    </div>
  );
}

export function MessageAttachments({ event }: { readonly event: CollectiveEventEnvelope }) {
  if (!event.attachments?.length) return null;
  return (
    <div className="message-attachments">
      {event.attachments.map((attachment) => (
        <MessageAttachment key={attachment.attachmentId} attachment={attachment} event={event} />
      ))}
    </div>
  );
}
