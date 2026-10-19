import { type ReactNode, useState } from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import {
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

function AuthenticatedWorkResultFile({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const open = () => {
    const sessionToken = currentCollectiveSessionToken();
    if (!sessionToken) {
      setFailed(true);
      return;
    }
    setFailed(false);
    const popup = window.open('about:blank', '_blank');
    void openCollectiveWorkResultFile(href, sessionToken, popup).catch(() => setFailed(true));
  };
  return (
    <>
      <button
        type="button"
        className="message-markdown-authenticated-file"
        data-collective-work-result-file=""
        onClick={open}
      >
        {children}
      </button>
      {failed && <output>文件暂时无法打开，请刷新后重试。</output>}
    </>
  );
}

export function MessageMarkdown({
  source,
  prefix,
  sourceCoordinates = false,
}: {
  readonly source: string;
  readonly prefix?: ReactNode;
  readonly sourceCoordinates?: boolean;
}) {
  const position = (node?: { position?: { start: { offset?: number }; end: { offset?: number } } }) =>
    sourceCoordinates
      ? {
          'data-source-start': node?.position?.start.offset,
          'data-source-end': node?.position?.end.offset,
        }
      : {};
  const sourceComponents: Components = sourceCoordinates
    ? {
        p: ({ node, ...props }) => <p {...props} {...position(node)} />,
        h1: ({ node, ...props }) => <h1 {...props} {...position(node)} />,
        h2: ({ node, ...props }) => <h2 {...props} {...position(node)} />,
        h3: ({ node, ...props }) => <h3 {...props} {...position(node)} />,
        li: ({ node, ...props }) => <li {...props} {...position(node)} />,
        td: ({ node, ...props }) => <td {...props} {...position(node)} />,
        pre: ({ node, ...props }) => <pre {...props} {...position(node)} />,
      }
    : {};
  return (
    <div className="message-body message-markdown">
      {prefix && <span className="message-prefix">{prefix}</span>}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={defaultUrlTransform}
        components={{
          ...sourceComponents,
          a: ({ children, href }) => {
            if (href && collectiveWorkResultFileAddress(href))
              return <AuthenticatedWorkResultFile href={href}>{children}</AuthenticatedWorkResultFile>;
            return isSafeWebLink(href) ? (
              <SafeLink href={href}>{children}</SafeLink>
            ) : (
              <InertLink>{children}</InertLink>
            );
          },
          img: ({ alt }) => <span className="message-markdown-inert-image">{alt ? `图片：${alt}` : '图片'}</span>,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
