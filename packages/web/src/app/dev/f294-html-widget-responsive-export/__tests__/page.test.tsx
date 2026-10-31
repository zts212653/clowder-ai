import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import HtmlWidgetResponsiveExportFixture from '../page';

vi.mock('@/components/rich/HtmlWidgetBlock', () => ({
  HtmlWidgetBlock: ({ block }: { block: { html?: string; id?: string } }) => (
    <div
      data-html-widget={block.id}
      data-source-html-code-points={typeof block.html === 'string' ? String(block.html.length) : 'missing'}
    />
  ),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

it.each([
  { fixtureMode: 'short', expectedWidgetId: 'short-widget', minimumHtmlLength: 1 },
  { fixtureMode: 'arbitrary-unknown', expectedWidgetId: 'responsive-export-widget', minimumHtmlLength: 1_000 },
  { fixtureMode: 'toString', expectedWidgetId: 'responsive-export-widget', minimumHtmlLength: 1_000 },
  { fixtureMode: 'constructor', expectedWidgetId: 'responsive-export-widget', minimumHtmlLength: 1_000 },
  { fixtureMode: '__proto__', expectedWidgetId: 'responsive-export-widget', minimumHtmlLength: 1_000 },
])('selects an own fixture for $fixtureMode without reading Object.prototype', async (fixtureCase) => {
  window.history.replaceState(null, '', `/?fixture=${encodeURIComponent(fixtureCase.fixtureMode)}`);

  await act(() => root.render(<HtmlWidgetResponsiveExportFixture />));

  const exportRoot = host.querySelector('[data-export-root]');
  const widget = host.querySelector('[data-html-widget]');
  expect(exportRoot?.getAttribute('data-export-ready')).toBe('true');
  expect(exportRoot?.getAttribute('data-export-fixture-mode')).toBe(fixtureCase.fixtureMode);
  expect(exportRoot?.getAttribute('data-export-widget-id')).toBe(fixtureCase.expectedWidgetId);
  expect(widget?.getAttribute('data-html-widget')).toBe(fixtureCase.expectedWidgetId);
  expect(Number(widget?.getAttribute('data-source-html-code-points'))).toBeGreaterThan(fixtureCase.minimumHtmlLength);
});
