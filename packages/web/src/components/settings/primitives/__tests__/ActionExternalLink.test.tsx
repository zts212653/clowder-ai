import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ActionPanelBody } from '../ActionRendererParts';

const mounted: Array<() => void> = [];
beforeAll(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose();
});
function render(url: string, render = 'url') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() =>
    root.render(
      <ActionPanelBody
        connectorId="music"
        phase="polling"
        currentAction={{ id: 'poll', label: '等待授权', render: 'polling' }}
        lastResult={{ render, label: '打开 Google 授权页', data: { url } }}
        errorMsg={null}
        onAction={() => {}}
      />,
    ),
  );
  return container;
}
it('shows an explicit external authorization link while waiting without automatic navigation', () => {
  const container = render('https://accounts.google.com/o/oauth2/v2/auth?state=public');
  const link = container.querySelector('a');
  expect(link?.textContent).toBe('打开 Google 授权页');
  expect(link?.getAttribute('href')).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=public');
  expect(link?.getAttribute('target')).toBe('_blank');
  expect(link?.getAttribute('rel')).toContain('noreferrer');
});
it('restored polling can show its recovered link, while unsafe URL schemes never render a link', () => {
  expect(render('https://accounts.google.com/o/oauth2/v2/auth', 'polling').querySelector('a')).not.toBeNull();
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'http://example.org',
    'https://user:secret@example.org',
  ])
    expect(render(value).querySelector('a')).toBeNull();
});
