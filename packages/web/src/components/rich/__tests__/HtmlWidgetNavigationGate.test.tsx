import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HtmlWidgetBlock } from '../HtmlWidgetBlock';
import { HtmlWidgetNavigationGate, resolveWidgetNavigation } from '../HtmlWidgetNavigationGate';

Object.assign(globalThis, { React });

describe('opaque widget navigation requests', () => {
  const origin = 'https://cafe.clowder-ai.com';
  it('allows only explicit source messages, OSM objects and local preview pages', () => {
    expect(resolveWidgetNavigation('/thread/thread_test?messageId=msg-1', origin)?.href).toBe(
      `${origin}/thread/thread_test?message=msg-1`,
    );
    expect(resolveWidgetNavigation('/thread/thread_test?message=msg-1', origin)?.href).toBe(
      `${origin}/thread/thread_test?message=msg-1`,
    );
    for (const message of ['', 'invalid:coordinate', 'x'.repeat(201)]) {
      expect(resolveWidgetNavigation(`/thread/thread_test?message=${message}`, origin)).toBeNull();
    }
    expect(resolveWidgetNavigation('https://www.openstreetmap.org/way/123', origin)?.label).toBe('打开地图');
    expect(resolveWidgetNavigation(`http://127.0.0.1:5176/?asset=${'a'.repeat(64)}`, origin)?.label).toBe(
      '打开本机页面',
    );
    for (const href of [
      'javascript:alert(1)',
      '//evil.test/thread/thread_test',
      '/thread/thread_test?messageId=1&next=https://evil.test',
      '/thread/thread_test#x',
      'https://evil.test/',
      'https://www.openstreetmap.org/user/me',
      'http://127.0.0.1:3004/',
      'http://127.0.0.1:6399/',
      'http://127.0.0.1:5176/api/secrets',
      'http://user@127.0.0.1:5176/',
      'http://127.0.0.1:5176/?asset=bad',
    ]) {
      expect(resolveWidgetNavigation(href, origin), href).toBeNull();
    }
  });

  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('requires the current opaque frame and a separate native user action', () => {
    const iframeRef = createRef<HTMLIFrameElement>();
    const mount = (contentKey: string) =>
      act(() =>
        root.render(
          <>
            <iframe ref={iframeRef} title="fixture" sandbox="allow-scripts" />
            <HtmlWidgetNavigationGate iframeRef={iframeRef} contentKey={contentKey} />
          </>,
        ),
      );
    mount('r1');
    const request = { type: 'cat-cafe:html-widget-navigation', v: 1, href: '/thread/thread_test?messageId=msg-1' };
    const send = (source: MessageEventSource | null, eventOrigin = 'null', data = request) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { source, origin: eventOrigin, data }));
      });
    send(window);
    const source = iframeRef.current?.contentWindow ?? null;
    expect(source).not.toBeNull();
    send(source, window.location.origin);
    send(source, 'null', { ...request, v: 2 });
    expect(container.querySelector('[data-widget-navigation]')).toBeNull();
    send(source);
    const link = container.querySelector<HTMLAnchorElement>('[data-widget-navigation] a');
    expect(link?.getAttribute('href')).toBe(`${window.location.origin}/thread/thread_test?message=msg-1`);
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
    act(() => container.querySelector<HTMLButtonElement>('[data-widget-navigation] button')?.click());
    expect(container.querySelector('[data-widget-navigation]')).toBeNull();
    send(source);
    mount('r2');
    expect(container.querySelector('[data-widget-navigation]')).toBeNull();
  });

  it.each(['chat', 'workspace'] as const)('connects the actual %s renderer to the host control', (presentation) => {
    act(() =>
      root.render(
        <HtmlWidgetBlock
          presentation={presentation}
          block={{
            id: 'source-fixture',
            kind: 'html_widget',
            v: 1,
            html: '<p>Reference</p>',
          }}
        />,
      ),
    );
    const frame = container.querySelector('iframe');
    expect(frame?.contentWindow).toBeTruthy();
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame?.contentWindow ?? null,
          origin: 'null',
          data: { type: 'cat-cafe:html-widget-navigation', v: 1, href: 'https://www.openstreetmap.org/way/123' },
        }),
      ),
    );
    expect(container.querySelector('[data-widget-navigation] a')?.textContent).toContain('打开地图');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
  });
});
