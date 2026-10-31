'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { HtmlWidgetBlock } from '@/components/rich/HtmlWidgetBlock';
import {
  CSSOM_FINAL_PROOF_RACE_WIDGET_HTML,
  CSSOM_FIXED_ROOT_PSEUDO_WIDGET_HTML,
  CSSOM_ROOT_PSEUDO_WIDGET_HTML,
  DELAYED_PROOF_WIDGET_HTML,
} from './html-widget-fixtures';

const HTML_WIDGET_EXPORT_FIXTURE_MESSAGE_ID = 'html-widget-export-fixture-message';

const PANELS = Array.from(
  { length: 24 },
  (_, index) =>
    `<section class="panel"><strong>Responsive panel ${index + 1}</strong><p>完整内容行 ${index + 1}</p></section>`,
).join('');

const RESPONSIVE_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      body { font: 14px/1.5 system-ui, sans-serif; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 12px; }
      .panel { min-height: 64px; padding: 10px; border: 1px solid currentColor; border-radius: 8px; }
      .panel p { margin: 6px 0 0; }
      #html-widget-bottom-sentinel { height: 28px; margin-top: 12px; background: magenta; color: black; text-align: center; line-height: 28px; }
      @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main class="grid">${PANELS}</main>
    <div id="html-widget-bottom-sentinel">HTML_WIDGET_BOTTOM_SENTINEL</div>
  </body>
</html>`;

const SHORT_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>html, body { height: 100%; margin: 0; } p { margin: 8px; }</style>
  </head>
  <body><p>Short widget content</p></body>
</html>`;

const VIEWPORT_RELATIVE_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>html, body { margin: 0; } body { min-height: calc(100vh + 1px); }</style>
  </head>
  <body><p>Viewport-relative widget content</p></body>
</html>`;

const VIEWPORT_FEEDBACK_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      html, body { height: 100%; margin: 0; overflow: hidden; }
      body { min-height: calc(100vh + 100px); display: flex; flex-direction: column; }
      p { margin: 8px; }
      #viewport-feedback-sentinel {
        height: 20px;
        margin-top: auto;
        background: magenta;
        flex: 0 0 20px;
      }
    </style>
  </head>
  <body>
    <p>Viewport feedback must never be declared export-ready.</p>
    <div id="viewport-feedback-sentinel">VIEWPORT_FEEDBACK_BOTTOM_SENTINEL</div>
  </body>
</html>`;

const ASYNC_IMAGE_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      html, body { height: 100%; margin: 0; overflow: hidden; }
      p { margin: 8px; }
      #async-image-sentinel { display: block; }
    </style>
  </head>
  <body>
    <p>Async image content must invalidate export readiness.</p>
    <script>
      setTimeout(() => {
        const image = document.createElement('img');
        image.id = 'async-image-sentinel';
        image.alt = 'ASYNC_IMAGE_BOTTOM_SENTINEL';
        image.src = '/dev/f294-html-widget-responsive-export/delayed-image?nonce=' + Date.now();
        document.body.append(image);
      }, 50);
    </script>
  </body>
</html>`;

const PSEUDO_CONTENT_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      html, body { height: 100%; margin: 0; overflow: hidden; }
      p { margin: 8px; }
      body::after {
        content: "PSEUDO_BOTTOM_SENTINEL";
        display: block;
        height: 1000px;
        background: #ff00ff;
      }
    </style>
  </head>
  <body><p>CSS generated content must be part of the rendered extent.</p></body>
</html>`;

const ROOT_PSEUDO_CONTENT_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; overflow: hidden; }
      p { margin: 8px; }
      html::after {
        content: "ROOT_PSEUDO_BOTTOM_SENTINEL";
        display: block;
        height: 1000px;
        background: #ff00ff;
      }
    </style>
  </head>
  <body><p>Root CSS generated content must be part of the rendered extent.</p></body>
</html>`;

const ROOT_PSEUDO_FEEDBACK_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      html, body { height: 100%; margin: 0; overflow: hidden; }
      p { margin: 8px; }
      html::after {
        content: "ROOT_PSEUDO_FEEDBACK_SENTINEL";
        display: block;
        height: 1000px;
        background: #ff00ff;
      }
    </style>
  </head>
  <body><p>Viewport-bound root generated content must fail closed.</p></body>
</html>`;

const FIXED_ROOT_PSEUDO_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      html, body { height: 100%; margin: 0; overflow: hidden; }
      p { margin: 8px; }
      html::after {
        content: "FIXED_ROOT_PSEUDO_SENTINEL";
        position: fixed;
        top: 1000px;
        height: 1000px;
        width: 100%;
        background: #ff00ff;
      }
    </style>
  </head>
  <body><p>Fixed generated paint outside scroll extent must fail closed.</p></body>
</html>`;

interface HtmlWidgetFixture {
  id: string;
  title: string;
  height: number;
  html: string;
}

const RESPONSIVE_FIXTURE: HtmlWidgetFixture = {
  id: 'responsive-export-widget',
  title: 'Responsive export widget',
  height: 1_250,
  html: RESPONSIVE_WIDGET_HTML,
};

const FIXTURES: Record<string, HtmlWidgetFixture> = {
  short: { id: 'short-widget', title: 'Short widget', height: 500, html: SHORT_WIDGET_HTML },
  'viewport-relative': {
    id: 'viewport-relative-widget',
    title: 'Viewport-relative widget',
    height: 300,
    html: VIEWPORT_RELATIVE_WIDGET_HTML,
  },
  'viewport-feedback': {
    id: 'viewport-feedback-widget',
    title: 'Viewport feedback widget',
    height: 300,
    html: VIEWPORT_FEEDBACK_WIDGET_HTML,
  },
  'async-image': { id: 'async-image-widget', title: 'Async image widget', height: 300, html: ASYNC_IMAGE_WIDGET_HTML },
  'pseudo-content': {
    id: 'pseudo-content-widget',
    title: 'Pseudo content widget',
    height: 300,
    html: PSEUDO_CONTENT_WIDGET_HTML,
  },
  'root-pseudo-content': {
    id: 'root-pseudo-content-widget',
    title: 'Root pseudo content widget',
    height: 300,
    html: ROOT_PSEUDO_CONTENT_WIDGET_HTML,
  },
  'root-pseudo-feedback': {
    id: 'root-pseudo-feedback-widget',
    title: 'Root pseudo feedback widget',
    height: 300,
    html: ROOT_PSEUDO_FEEDBACK_WIDGET_HTML,
  },
  'fixed-root-pseudo': {
    id: 'fixed-root-pseudo-widget',
    title: 'Fixed root pseudo widget',
    height: 300,
    html: FIXED_ROOT_PSEUDO_WIDGET_HTML,
  },
  'cssom-fixed-root-pseudo': {
    id: 'cssom-fixed-root-pseudo-widget',
    title: 'CSSOM fixed root pseudo widget',
    height: 300,
    html: CSSOM_FIXED_ROOT_PSEUDO_WIDGET_HTML,
  },
  'cssom-final-proof-race': {
    id: 'cssom-final-proof-race-widget',
    title: 'CSSOM final proof race widget',
    height: 300,
    html: CSSOM_FINAL_PROOF_RACE_WIDGET_HTML,
  },
  'delayed-proof': {
    id: 'delayed-proof-widget',
    title: 'Delayed proof widget',
    height: 300,
    html: DELAYED_PROOF_WIDGET_HTML,
  },
  'cssom-root-pseudo-content': {
    id: 'cssom-root-pseudo-content-widget',
    title: 'CSSOM root pseudo content widget',
    height: 300,
    html: CSSOM_ROOT_PSEUDO_WIDGET_HTML,
  },
};

function subscribeToLocation(): () => void {
  return () => {};
}

function readLocationSearch(): string {
  return window.location.search;
}

export default function HtmlWidgetResponsiveExportFixture() {
  const search = useSyncExternalStore(subscribeToLocation, readLocationSearch, () => null);
  const hydrated = search !== null;
  const searchParams = new URLSearchParams(search ?? '');
  const selectedMessageIds = searchParams.getAll('messageId');
  const selected =
    hydrated && (selectedMessageIds.length === 0 || selectedMessageIds.includes(HTML_WIDGET_EXPORT_FIXTURE_MESSAGE_ID));
  const fixtureMode = searchParams.get('fixture') ?? 'responsive';
  const unstableExport = hydrated && searchParams.get('unstable') === '1';
  const [unstableHeight, setUnstableHeight] = useState(900);

  useEffect(() => {
    if (!unstableExport) return;
    const timer = window.setInterval(() => setUnstableHeight((height) => height + 1), 100);
    return () => window.clearInterval(timer);
  }, [unstableExport]);

  const fixture = Object.hasOwn(FIXTURES, fixtureMode) ? FIXTURES[fixtureMode] : RESPONSIVE_FIXTURE;

  return (
    <main
      data-export-root
      data-export-ready={hydrated ? 'true' : undefined}
      data-export-fixture-mode={hydrated ? fixtureMode : undefined}
      data-export-message-id={hydrated ? HTML_WIDGET_EXPORT_FIXTURE_MESSAGE_ID : undefined}
      data-export-widget-id={hydrated ? fixture.id : undefined}
      className="mx-auto min-h-screen max-w-4xl p-4"
    >
      <h1 className="mb-4 text-lg font-semibold text-cafe-primary">F294 HTML widget responsive export fixture</h1>
      {selected ? (
        <>
          {fixtureMode === 'offscreen' ? <div data-offscreen-export-spacer style={{ height: '5000px' }} /> : null}
          <article data-message-id={HTML_WIDGET_EXPORT_FIXTURE_MESSAGE_ID}>
            <HtmlWidgetBlock
              block={{
                id: fixture.id,
                kind: 'html_widget',
                v: 1,
                title: fixture.title,
                height: fixture.height,
                html: fixture.html,
              }}
            />
            {unstableExport ? <div data-unstable-export-spacer style={{ height: `${unstableHeight}px` }} /> : null}
          </article>
        </>
      ) : null}
    </main>
  );
}
