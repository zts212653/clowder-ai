export interface ComposerAttachmentItem {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly url?: string;
  readonly status?: 'uploading' | 'ready' | 'failed';
  readonly notice?: string;
}
export function formatAttachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Home and Channel share preview, removal, progress and retry presentation; their hosts own upload/custody. */
export function ComposerAttachmentPreview({
  items,
  onRemove,
  onOpen,
  onRetry,
  labels,
}: {
  readonly items: readonly ComposerAttachmentItem[];
  readonly onRemove: (id: string) => void;
  readonly onOpen?: (id: string) => void;
  readonly onRetry?: (id: string) => void;
  readonly labels?: { remove: (name: string) => string; retry: string; uploading: string };
}) {
  if (!items.length) return null;
  return (
    <div className="cafe-attachment-previews" role="group" aria-label="Attachments">
      {items.map((item) => (
        <div key={item.id} className="cafe-attachment-preview" data-status={item.status}>
          <button
            type="button"
            className="cafe-attachment-open"
            onClick={() => onOpen?.(item.id)}
            disabled={!onOpen}
            aria-label={item.name}
          >
            {item.mediaType.startsWith('image/') && item.url ? (
              <img src={item.url} alt={item.name} />
            ) : (
              <span className="cafe-attachment-file" aria-hidden="true">
                {item.mediaType.startsWith('audio/') ? '♫' : item.mediaType.startsWith('video/') ? '▷' : '▤'}
              </span>
            )}
          </button>
          <button
            type="button"
            className="cafe-attachment-remove"
            onClick={() => onRemove(item.id)}
            aria-label={labels?.remove(item.name) ?? `移除 ${item.name}`}
          >
            ×
          </button>
          <span className="cafe-attachment-name" title={item.name}>
            {item.name}
          </span>
          <small>
            {item.status === 'uploading' ? (labels?.uploading ?? '正在上传…') : formatAttachmentSize(item.byteLength)}
          </small>
          {item.notice && (
            <span role="status" className="cafe-attachment-error">
              {item.notice}
            </span>
          )}
          {item.status === 'failed' && onRetry && (
            <button type="button" className="cafe-attachment-retry" onClick={() => onRetry(item.id)}>
              {labels?.retry ?? '重试'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
