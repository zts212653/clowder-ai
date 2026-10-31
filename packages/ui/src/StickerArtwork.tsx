import type { ReactNode } from 'react';

/** A sticker uses its actual retained image; an identity label never substitutes different pixels. */
export function StickerArtwork({
  src,
  alt,
  onOpen,
  children,
}: {
  readonly src?: string;
  readonly alt?: string;
  readonly onOpen?: () => void;
  readonly children?: ReactNode;
}) {
  const image = <img src={src} alt={alt ?? ''} loading="lazy" />;
  return (
    <span className="cafe-message-sticker">
      {children ??
        (onOpen ? (
          <button type="button" onClick={onOpen} aria-label={alt}>
            {image}
          </button>
        ) : (
          image
        ))}
    </span>
  );
}
