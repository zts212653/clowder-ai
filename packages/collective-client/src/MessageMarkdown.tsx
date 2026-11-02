import { isCollectiveAttachmentUrl } from '@cat-cafe/shared';
import { MarkdownSurface } from '@cat-cafe/ui';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { type Components, defaultUrlTransform } from 'react-markdown';
import type { CollectiveEventEnvelope } from './client-types.js';
import { useCollectiveText } from './collective-copy.js';
import { MessageAttachment } from './MessageAttachments.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';
import {
  type CollectiveWorkResultFileAddress,
  collectiveWorkResultFileAddress,
  currentCollectiveSessionToken,
  openCollectiveWorkResultFile,
} from './work-result-file-link.js';

function isSafeWebLink(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function InertLink({ children }: { readonly children: ReactNode }) {
  return <span className="message-markdown-inert-link">{children}</span>;
}

function SafeLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function AuthenticatedWorkResultFile({
  address,
  children,
}: {
  readonly address: CollectiveWorkResultFileAddress;
  readonly children: ReactNode;
}) {
  const shared = useSharedArtifacts();
  const t = useCollectiveText();
  const promotable = address.fileName.toLocaleLowerCase().endsWith('.md');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = () => {
    if (pending) return;
    setFailed(false);
    setPending(true);
    let action: Promise<void>;
    if (promotable) {
      const promote = shared?.openWorkResultFile;
      if (!promote) {
        setFailed(true);
        setPending(false);
        return;
      }
      action = promote(address);
    } else {
      const sessionToken = currentCollectiveSessionToken();
      if (!sessionToken) {
        setFailed(true);
        setPending(false);
        return;
      }
      action = openCollectiveWorkResultFile(address, sessionToken, window.open('about:blank', '_blank'));
    }
    void action.catch(() => setFailed(true)).finally(() => setPending(false));
  };
  return (
    <>
      <button
        type="button"
        className="message-markdown-authenticated-file"
        data-collective-work-result-file=""
        aria-busy={pending}
        disabled={pending}
        onClick={open}
      >
        {pending ? t('正在打开作品…') : children}
      </button>
      {failed && (
        <output>
          {t(promotable ? '结果作品暂时无法打开；原结果仍已保留，可以稍后重试。' : '文件暂时无法打开，请刷新后重试。')}
        </output>
      )}
    </>
  );
}

const MessageMarkdownEvent = createContext<CollectiveEventEnvelope | undefined>(undefined);
const messageMarkdownComponents: Components = {
  a: function MessageLink({ children, href }) {
    const result = href ? collectiveWorkResultFileAddress(href) : undefined;
    if (result) return <AuthenticatedWorkResultFile address={result}>{children}</AuthenticatedWorkResultFile>;
    return isSafeWebLink(href) ? <SafeLink href={href}>{children}</SafeLink> : <InertLink>{children}</InertLink>;
  },
  img: function MessageImage({ src, alt }) {
    const event = useContext(MessageMarkdownEvent);
    const attachment = event?.attachments?.find((item) => item.contentRef === src);
    return event && attachment && attachment.mediaType.startsWith('image/') ? (
      <MessageAttachment attachment={attachment} event={event} imageDescription={alt} inline />
    ) : (
      <span className="message-markdown-inert-image">{alt ? `图片：${alt}` : '图片'}</span>
    );
  },
};

export function MessageMarkdown({
  source,
  prefix,
  sourceCoordinates = false,
  event,
}: {
  readonly source: string;
  readonly prefix?: ReactNode;
  readonly sourceCoordinates?: boolean;
  readonly event?: CollectiveEventEnvelope;
}) {
  return (
    <MessageMarkdownEvent.Provider value={event}>
      <div className="message-body message-markdown">
        {prefix && <span className="message-prefix">{prefix}</span>}
        <MarkdownSurface
          sourceCoordinates={sourceCoordinates}
          urlTransform={(url) => (isCollectiveAttachmentUrl(url) ? url : defaultUrlTransform(url))}
          components={messageMarkdownComponents}
        >
          {source}
        </MarkdownSurface>
      </div>
    </MessageMarkdownEvent.Provider>
  );
}
