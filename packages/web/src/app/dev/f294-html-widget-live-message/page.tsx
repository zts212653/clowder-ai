'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { HtmlWidgetBlock } from '@/components/rich/HtmlWidgetBlock';
import { LIVE_MESSAGE_WIDGET_HTML } from './live-message-widget-fixture';

const EMPTY_WIDGET_DOCUMENT = '<!doctype html><html><head></head><body></body></html>';

function containsEmptyWidgetIframe(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  const frames = node.matches('iframe') ? [node] : Array.from(node.querySelectorAll('iframe'));
  return frames.some((frame) => frame.getAttribute('srcdoc') === EMPTY_WIDGET_DOCUMENT);
}

export default function HtmlWidgetLiveMessageFixture() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [sawEmptyIframe, setSawEmptyIframe] = useState(false);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new MutationObserver((records) => {
      if (records.some((record) => Array.from(record.addedNodes).some(containsEmptyWidgetIframe))) {
        setSawEmptyIframe(true);
      }
    });
    observer.observe(host, { childList: true, subtree: true });
    const timer = window.setTimeout(() => setMounted(true), 100);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  return (
    <main
      data-live-message-widget-fixture
      data-empty-iframe-observed={sawEmptyIframe ? 'true' : 'false'}
      data-source-html-code-points={Array.from(LIVE_MESSAGE_WIDGET_HTML).length}
      className="mx-auto min-h-screen max-w-4xl p-4"
    >
      <h1 className="mb-4 text-lg font-semibold text-cafe-primary">F294 live message html_widget fixture</h1>
      <div ref={hostRef}>
        {mounted ? (
          <article data-message-id="html-widget-live-message-fixture">
            <HtmlWidgetBlock
              block={{
                id: 'ai-agent-priority-convergence-20260821-v1',
                kind: 'html_widget',
                v: 1,
                title: 'AI Agent 项目：从千头万绪到一条主线',
                height: 1_550,
                html: LIVE_MESSAGE_WIDGET_HTML,
              }}
            />
          </article>
        ) : (
          <p data-live-message-pending className="text-sm text-cafe-secondary">
            Waiting for live rich block…
          </p>
        )}
      </div>
    </main>
  );
}
