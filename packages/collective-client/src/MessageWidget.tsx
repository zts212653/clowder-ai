import type { RichHtmlWidgetBlock } from '@cat-cafe/shared';
import { publicWidgetDocument, SandboxedWidgetFrame } from '@cat-cafe/ui';
import { useEffect, useState } from 'react';
import { useCollectiveLanguage } from './collective-copy.js';

export function MessageWidget({ block }: { block: RichHtmlWidgetBlock }) {
  const en = useCollectiveLanguage() === 'en';
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setHtml(undefined);
    setError(undefined);
    try {
      const nonce = document.querySelector<HTMLMetaElement>('meta[name="collective-widget-nonce"]')?.content;
      if (!nonce) throw new Error(en ? 'Reload to enable this visualization' : '请刷新页面以打开交互内容');
      setHtml(publicWidgetDocument(block.html, nonce));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [block.html, en]);
  return (
    <section className="cafe-rich-widget">
      {block.title && <h4>{block.title}</h4>}
      {html ? (
        <SandboxedWidgetFrame
          html={html}
          title={block.title ?? (en ? 'Interactive content' : '交互内容')}
          height={block.height ?? 300}
          scrolling="auto"
        />
      ) : (
        <p role="status">{error ?? (en ? 'Preparing…' : '正在准备…')}</p>
      )}
    </section>
  );
}
