import { DiffViewer, RichCardContent, RichChecklist, RichGallery } from '@cat-cafe/ui';
import type { CollectiveEventEnvelope } from './client-types.js';
import { MessageAttachment } from './MessageAttachments.js';
import { MessageChoices } from './MessageChoices.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { MessageWidget } from './MessageWidget.js';

export function MessageRichBlocks({ event }: { event: CollectiveEventEnvelope }) {
  const media = (url: string, caption?: string) => {
    const attachment = event.attachments?.find((item) => item.contentRef === url);
    return attachment ? (
      <figure key={attachment.attachmentId}>
        <MessageAttachment event={event} attachment={attachment} imageDescription={caption} />
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
    ) : (
      <p role="status">{caption ?? 'Media unavailable'}</p>
    );
  };
  return (
    <div className="message-rich-blocks">
      {event.richBlocks?.map((block) => (
        <div key={block.id} data-rich-block={block.id} data-rich-kind={block.kind}>
          {block.kind === 'card' ? (
            <RichCardContent block={block} markdown={(source) => <MessageMarkdown source={source} event={event} />} />
          ) : block.kind === 'checklist' ? (
            <RichChecklist title={block.title} items={block.items} />
          ) : block.kind === 'diff' ? (
            <section className="cafe-rich-diff">
              <h4>{block.filePath}</h4>
              <DiffViewer diff={block.diff} fallbackFilePath={block.filePath} compact />
            </section>
          ) : block.kind === 'media_gallery' ? (
            <RichGallery title={block.title}>
              {block.items.map((item) => media(item.url, item.caption ?? item.alt))}
            </RichGallery>
          ) : block.kind === 'audio' ? (
            <section>
              <h4>{block.title}</h4>
              {media(block.url, block.text)}
            </section>
          ) : block.kind === 'file' ? (
            media(block.url)
          ) : block.kind === 'html_widget' ? (
            <MessageWidget block={block} />
          ) : (
            <MessageChoices block={block} event={event} />
          )}
        </div>
      ))}
    </div>
  );
}
