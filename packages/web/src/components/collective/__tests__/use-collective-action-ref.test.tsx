// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({
  pathname: null as string | null,
  searchParams: null as URLSearchParams | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.searchParams,
}));

import { useCollectiveActionRef } from '../use-collective-action-ref';

function ActionRefProbe() {
  return <output data-testid="action-ref">{useCollectiveActionRef()}</output>;
}

describe('useCollectiveActionRef', () => {
  let container: HTMLDivElement;
  let root: Root;

  function render() {
    act(() => root.render(<ActionRefProbe />));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    navigation.pathname = null;
    navigation.searchParams = null;
    window.history.replaceState(null, '', '/collective');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    navigation.pathname = null;
    navigation.searchParams = null;
    window.history.replaceState(null, '', '/');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('uses the committed Next route snapshot before the browser address catches up', () => {
    window.history.replaceState(null, '', '/thread/thread-source');
    navigation.pathname = '/collective';
    navigation.searchParams = new URLSearchParams('from=thread-source');

    render();

    expect(container.textContent).toBe('/collective?from=thread-source');
  });

  it('keeps explicit target fields exact when Next changes only the query', () => {
    navigation.pathname = '/collective';
    navigation.searchParams = new URLSearchParams('collectiveId=col_target000');
    render();
    expect(container.textContent).toBe('/collective?collectiveId=col_target000');

    navigation.searchParams = new URLSearchParams(
      'serviceUrl=http%3A%2F%2Flocalhost%3A5201&serviceInstanceId=svc_12345678&collectiveId=col_target000',
    );
    render();
    expect(container.textContent).toBe(
      '/collective?serviceUrl=http%3A%2F%2Flocalhost%3A5201&serviceInstanceId=svc_12345678&collectiveId=col_target000',
    );
  });

  it('falls back to browser history and follows popstate outside a Next router provider', () => {
    window.history.replaceState(null, '', '/collective?from=thread-source');
    render();
    expect(container.textContent).toBe('/collective?from=thread-source');

    act(() => {
      window.history.pushState(null, '', '/collective?collectiveId=col_target000');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(container.textContent).toBe('/collective?collectiveId=col_target000');
  });
});
