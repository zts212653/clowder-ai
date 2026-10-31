import type { RichCardBlock } from '@cat-cafe/shared';
import { type ComponentProps, forwardRef, type ReactNode } from 'react';

/** Each host supplies authenticated media and its own publication actions. */
export function RichGallery({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="cafe-rich-media-gallery rounded-lg border border-cafe p-3">
      {title && <h4 className="font-medium text-sm mb-2">{title}</h4>}
      <div className="cafe-rich-gallery">{children}</div>
      {footer}
    </section>
  );
}

export function MediaThumbnail({
  src,
  alt,
  label,
  onOpen,
  disabled,
  onError,
  className,
  imageClassName,
}: {
  src: string;
  alt: string;
  label: string;
  onOpen: () => void;
  disabled?: boolean;
  onError?: () => void;
  className?: string;
  imageClassName?: string;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onOpen} aria-label={label} className={className}>
      <img src={src} alt={alt} loading="lazy" onError={onError} className={imageClassName} />
    </button>
  );
}

export function RichCardContent({
  block,
  markdown,
}: {
  block: RichCardBlock;
  markdown: (source: string) => ReactNode;
}) {
  return (
    <section className="cafe-rich-card" data-tone={block.tone ?? 'info'}>
      <h4>{block.title}</h4>
      {block.bodyMarkdown && markdown(block.bodyMarkdown)}
      {block.fields?.length ? (
        <dl>
          {block.fields.map((field, index) => (
            <div key={`${field.label}:${index}`}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

export function RichChecklist({
  title,
  items,
  renderCheck,
}: {
  title?: string;
  items: readonly { id: string; text: string; checked?: boolean }[];
  renderCheck?: (checked: boolean) => ReactNode;
}) {
  return (
    <section className="cafe-rich-checklist rounded-lg border border-cafe p-3">
      {title && <div className="font-medium text-sm mb-2">{title}</div>}
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id} data-checked={Boolean(item.checked)} className="flex items-start gap-2 text-sm">
            {renderCheck ? (
              renderCheck(Boolean(item.checked))
            ) : (
              <input type="checkbox" checked={Boolean(item.checked)} readOnly aria-label={item.text} />
            )}
            <span className={item.checked ? 'line-through text-cafe-muted' : ''}>{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** File custody, download/open authorization and video publication remain at the calling location. */
export function FileSummary({
  fileName,
  name,
  size,
  icon,
  children,
}: {
  fileName: string;
  name?: ReactNode;
  size?: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="cafe-file-summary flex items-center gap-3 rounded-lg border border-cafe px-4 py-3">
      {icon}
      <span className="cafe-file-summary-name min-w-0 flex-1" title={fileName}>
        <span className="text-sm font-medium">{name ?? fileName}</span>
        {size && <small className="text-xs text-cafe-muted">{size}</small>}
      </span>
      <span className="cafe-file-summary-actions">{children}</span>
    </div>
  );
}

export function AudioPlayer({ url, label, caption }: { url: string; label: string; caption?: ReactNode }) {
  return (
    <figure className="cafe-audio-player">
      <AudioElement src={url} aria-label={label} controls preload="metadata" />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

export const AudioElement = forwardRef<HTMLAudioElement, ComponentProps<'audio'>>(function AudioElement(props, ref) {
  return <audio {...props} ref={ref} />;
});
