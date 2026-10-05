import type { ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

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

export function MessageMarkdown({ source }: { readonly source: string }) {
  return (
    <div className="message-body message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={defaultUrlTransform}
        components={{
          a: ({ children, href }) =>
            isSafeWebLink(href) ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <InertLink>{children}</InertLink>
            ),
          img: ({ alt }) => <span className="message-markdown-inert-image">{alt ? `图片：${alt}` : '图片'}</span>,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
