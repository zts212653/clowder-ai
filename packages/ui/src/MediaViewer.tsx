import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface MessageMediaItem {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly mediaType: string;
}
/** The same accessible media window for Home and Channel; source navigation belongs to its host. */
export function MessageMediaViewer({
  item,
  title,
  children,
  onClose,
  onReturn,
  returnLabel = '回到原消息',
  closeLabel = '关闭',
  items = [],
  onSelect,
}: {
  readonly item: MessageMediaItem;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly onClose: () => void;
  readonly onReturn?: () => void;
  readonly returnLabel?: string;
  readonly closeLabel?: string;
  readonly items?: readonly MessageMediaItem[];
  readonly onSelect?: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnedToSource = useRef(false);
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      if (!returnedToSource.current && prior?.isConnected) prior.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="cafe-media-viewer"
      aria-label={item.title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="cafe-media-window">
        <header>
          <span>{title ?? item.title}</span>
          <div>
            {onReturn && (
              <button
                type="button"
                onClick={() => {
                  returnedToSource.current = true;
                  dialog.current?.close();
                  onReturn();
                }}
              >
                {returnLabel}
              </button>
            )}
            <button type="button" onClick={onClose} aria-label={closeLabel}>
              ×
            </button>
          </div>
        </header>
        <div className="cafe-media-stage">
          {children ??
            (item.mediaType.startsWith('image/') ? (
              <img src={item.url} alt={item.title} />
            ) : item.mediaType.startsWith('video/') ? (
              <video controls preload="metadata" src={item.url} aria-label={item.title} />
            ) : item.mediaType.startsWith('audio/') ? (
              <audio controls preload="metadata" src={item.url} aria-label={item.title} />
            ) : (
              <a href={item.url} download={item.title}>
                {item.title}
              </a>
            ))}
        </div>
        {items.length > 1 && (
          <nav className="cafe-media-thumbnails" aria-label="Media">
            {items.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                aria-label={candidate.title}
                aria-current={candidate.id === item.id}
                onClick={() => onSelect?.(candidate.id)}
              >
                {candidate.mediaType.startsWith('image/') ? (
                  <img src={candidate.url} alt={candidate.title} />
                ) : (
                  candidate.title
                )}
              </button>
            ))}
          </nav>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
