import type { MediaGalleryOrigin } from '@cat-cafe/shared';

export interface ArtworkGalleryItem {
  readonly url: string;
  readonly title: string;
  readonly alt: string;
  readonly mediaType: 'image' | 'video';
  readonly caption?: string;
  readonly origin?: MediaGalleryOrigin;
}
export interface ArtworkGallery {
  readonly items: readonly ArtworkGalleryItem[];
  readonly index: number;
  readonly onSelect: (index: number) => void;
  readonly busy?: boolean;
  readonly selectionCounts?: Readonly<Record<number, number>>;
}

/** Gallery paging never takes typing, IME, menu or media-control keys away from their owner. */
export function galleryNavigationBlocked(event: KeyboardEvent | WheelEvent): boolean {
  return (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    ('isComposing' in event && event.isComposing) ||
    (event.target instanceof Element &&
      !!event.target.closest(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="menu"],[role="menuitem"],video,audio,[data-gallery-input]',
      ))
  );
}
