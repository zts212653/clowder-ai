// @vitest-environment jsdom

import { collectiveHostAppearanceSchema } from '@cat-cafe/shared';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '../../shell/shell-presentation';
import type { ResolveHostColor } from '../collective-appearance-producer';
import { useCollectiveAppearanceBridge } from '../use-collective-appearance-bridge';
import type { ObservedFrameGeneration } from '../use-collective-world-directory';

/**
 * F322 B — the host side of the appearance bridge: when the frame generation exists, say the Café's look to that frame and
 * to nobody else, and say it again only when it changed. Values come from the page's own resolved tokens, so the triggers
 * are the things that change them: the interface version, the resolved scheme on <html>, and the theme / co-creator
 * styles injected into <head>.
 */
const ORIGIN = 'http://localhost:5201';
const generation = (bridgeId: string): ObservedFrameGeneration => ({ bridgeId, serviceOrigin: ORIGIN });

let tokens: Record<string, string | undefined>;
const resolveColor: ResolveHostColor = (variable) => tokens[variable];
const defaultTokens = (): Record<string, string | undefined> => ({
  '--cafe-surface-canvas': '#fbf7f2',
  '--cafe-surface': '#f6efe7',
  '--cafe-surface-sunken': '#ece3d9',
  '--cafe-text': '#2a211b',
  '--cafe-text-muted': '#6c5f55',
  '--cafe-accent': '#7a5a43',
  '--color-cocreator-primary': '#8c6f5a',
  '--color-cocreator-surface': '#e3d2c3',
  '--color-cocreator-text': '#2c1f1f',
});

function Harness({
  iframe,
  frameGeneration,
}: {
  readonly iframe: HTMLIFrameElement;
  readonly frameGeneration?: ObservedFrameGeneration;
}) {
  const iframeRef = useRef(iframe);
  useCollectiveAppearanceBridge({ iframeRef, frameGeneration, resolveColor });
  return null;
}

describe('useCollectiveAppearanceBridge', () => {
  let container: HTMLDivElement;
  let root: Root;
  let iframe: HTMLIFrameElement;
  let post: ReturnType<typeof vi.fn>;

  const render = (frameGeneration?: ObservedFrameGeneration) =>
    act(async () => root.render(<Harness iframe={iframe} frameGeneration={frameGeneration} />));
  const settle = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));
  const messages = () => post.mock.calls.map(([message]) => collectiveHostAppearanceSchema.parse(message));

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    tokens = defaultTokens();
    localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
    container = document.createElement('div');
    iframe = document.createElement('iframe');
    document.body.append(container, iframe);
    post = vi.fn();
    const frameWindow = iframe.contentWindow;
    if (!frameWindow) throw new Error('Expected iframe contentWindow');
    vi.spyOn(frameWindow, 'postMessage').mockImplementation(post as never);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    iframe.remove();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-theme');
    for (const style of document.head.querySelectorAll('style[data-test]')) style.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('says nothing before the frame has a generation', async () => {
    await render(undefined);
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();

    expect(post).not.toHaveBeenCalled();
  });

  it('says the look once to that frame and that Service origin when the generation exists', async () => {
    await render(generation('bridge_aaaaaaaa'));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toBe(ORIGIN);
    expect(messages()[0]).toMatchObject({
      bridgeId: 'bridge_aaaaaaaa',
      appearanceRevision: 1,
      presentation: 'classic',
      resolvedScheme: 'light',
      roles: { canvas: '#fbf7f2', humanSurface: '#e3d2c3', humanName: '#2c1f1f' },
    });
  });

  it('follows the resolved scheme on <html> and says it with the next revision', async () => {
    await render(generation('bridge_aaaaaaaa'));
    tokens = { ...tokens, '--cafe-surface-canvas': '#1c1815', '--cafe-text': '#f1e9e1' };
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();

    expect(messages().map((m) => [m.appearanceRevision, m.resolvedScheme])).toEqual([
      [1, 'light'],
      [2, 'dark'],
    ]);
    expect(messages()[1].roles).toMatchObject({ canvas: '#1c1815', text: '#f1e9e1' });
  });

  it('follows a tuned theme or a co-creator colour injected into <head>, whatever store produced it', async () => {
    await render(generation('bridge_aaaaaaaa'));
    tokens = { ...tokens, '--color-cocreator-surface': '#ddc9c9' };
    const style = document.createElement('style');
    style.dataset.test = 'cocreator';
    document.head.append(style);
    await settle();
    style.textContent = ':root{--cocreator-hue:18}';
    await settle();

    expect(messages().map((m) => [m.appearanceRevision, m.roles.humanSurface])).toEqual([
      [1, '#e3d2c3'],
      [2, '#ddc9c9'],
    ]);
  });

  it('does not repeat itself when the page changed but the look did not', async () => {
    await render(generation('bridge_aaaaaaaa'));
    const style = document.createElement('style');
    style.dataset.test = 'unrelated';
    style.textContent = '.x{color:red}';
    document.head.append(style);
    document.documentElement.setAttribute('class', 'something-else');
    await settle();

    expect(post).toHaveBeenCalledTimes(1);
  });

  it('follows the interface version without a reload', async () => {
    await render(generation('bridge_aaaaaaaa'));
    await act(async () => writeShellPresentation('v2'));
    await settle();

    expect(messages().map((m) => [m.appearanceRevision, m.presentation])).toEqual([
      [1, 'classic'],
      [2, 'v2'],
    ]);
  });

  it('starts a new frame generation at revision 1 and never speaks to the old one again', async () => {
    await render(generation('bridge_aaaaaaaa'));
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();
    await render(generation('bridge_bbbbbbbb'));
    document.documentElement.setAttribute('data-theme', 'light');
    await settle();

    expect(messages().map((m) => [m.bridgeId, m.appearanceRevision])).toEqual([
      ['bridge_aaaaaaaa', 1],
      ['bridge_aaaaaaaa', 2],
      ['bridge_bbbbbbbb', 1],
      ['bridge_bbbbbbbb', 2],
    ]);
  });

  it('says nothing when a role cannot be resolved, and speaks once it can', async () => {
    tokens = { ...tokens, '--cafe-accent': undefined };
    await render(generation('bridge_aaaaaaaa'));
    expect(post).not.toHaveBeenCalled();

    tokens = { ...tokens, '--cafe-accent': '#7a5a43' };
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();

    expect(messages().map((m) => m.appearanceRevision)).toEqual([1]);
  });

  it('stops observing the page when the frame goes away', async () => {
    await render(generation('bridge_aaaaaaaa'));
    await render(undefined);
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();

    expect(post).toHaveBeenCalledTimes(1);
  });
});
