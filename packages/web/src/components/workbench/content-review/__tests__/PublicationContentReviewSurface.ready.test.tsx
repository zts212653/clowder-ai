import { createHash } from 'node:crypto';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceSurfaceVisibilityProvider } from '../../WorkspaceSurfaceVisibility';
import { PublicationContentReviewSurface } from '../PublicationContentReviewSurface';
import { usePublicationDisplay } from '../usePublicationDisplay';
import { mediaView } from './WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), decode: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
const contentRef = `prepared-media:${'e'.repeat(64)}`;
let root: Root, container: HTMLDivElement;
let latest = 2;
let readAsset: ((value: unknown) => void) | null;
let pendingAsset = false;
let wrongView = false;

function fixture(ownerRevision: number) {
  const view = mediaView();
  const old = view.review.source;
  if (old.kind !== 'media') throw new Error('image fixture expected');
  const publication = {
    contentRef,
    ownerRevision,
    blobDigest: old.revision,
    ownerReceiptRef: 'media-receipt',
    sourcePublication: {
      artifactRef: '/uploads/cover.png',
      sourceRef: 'message:published',
      revision: String(ownerRevision),
    },
  };
  const asset = { ...publication, mediaType: old.mime, media: old.media };
  const source = {
    kind: 'publication' as const,
    // F138 review identity hashes the publication coordinates; it is not the media blob digest.
    revision: `sha256:${createHash('sha256')
      .update(JSON.stringify([contentRef, ownerRevision]))
      .digest('hex')}`,
    mime: old.mime,
    media: old.media,
    publication,
  };
  if (wrongView) source.publication.contentRef = `prepared-media:${'f'.repeat(64)}`;
  return {
    view: { ...view, review: { ...view.review, source, revision: 99 }, currentSource: source },
    asset,
  };
}

// Keep decoded native pixels mounted to isolate each observation predicate from projection guards.
function Observation({ data, enabled = true }: { data: ReturnType<typeof fixture>; enabled?: boolean }) {
  const observed = useRef<HTMLElement>(null);
  usePublicationDisplay(
    observed,
    enabled ? { contentRef, ownerRevision: 2, asset: data.asset } : undefined,
    data.view,
    null,
  );
  return (
    <section ref={observed} data-testid="workspace-content-review-surface">
      {/* biome-ignore lint/performance/noImgElement: This unit observes native image decoding, not page optimization. */}
      <img
        alt="publication observation fixture"
        data-testid="workspace-content-review-media"
        src={`http://api.test/api/content-publications/${encodeURIComponent(contentRef)}/media/2`}
      />
    </section>
  );
}

async function render(ownerRevision = 2, visible = true) {
  await act(async () => {
    root.render(
      <WorkspaceSurfaceVisibilityProvider visible={visible}>
        <PublicationContentReviewSurface
          contentRef={contentRef}
          ownerRevision={ownerRevision}
          title="封面"
          onBack={vi.fn()}
        />
      </WorkspaceSurfaceVisibilityProvider>,
    );
  });
}
function surface() {
  return container.querySelector<HTMLElement>('[data-testid="workspace-content-review-surface"]');
}
function expectAbsent() {
  for (const name of ['data-content-ref', 'data-owner-revision', 'data-content-ready'])
    expect(surface()?.getAttribute(name) ?? null).toBeNull();
}
function expectReady(ownerRevision = 2) {
  expect(surface()?.getAttribute('data-content-ref')).toBe(contentRef);
  expect(surface()?.getAttribute('data-owner-revision')).toBe(String(ownerRevision));
  expect(surface()?.getAttribute('data-content-ready')).toBe('true');
}
async function load(image = container.querySelector('img'), width = 160) {
  if (!image) throw new Error('real media element expected');
  Object.defineProperties(image, {
    decode: { configurable: true, value: mocks.decode },
    currentSrc: { configurable: true, value: image.src },
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: width ? 100 : 0 },
  });
  await act(async () => image.dispatchEvent(new Event('load')));
  return image;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  latest = 2;
  pendingAsset = false;
  readAsset = null;
  wrongView = false;
  mocks.apiFetch.mockReset();
  mocks.decode.mockReset().mockResolvedValue(undefined);
  let preparedRevision = 2;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300));
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 400, 300),
  ] as unknown as DOMRectList);
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/content-publications/')) {
      const revision = Number(new URL(url, 'http://api.test').searchParams.get('ownerRevision'));
      const value = { asset: fixture(revision).asset, currentOwnerRevision: latest };
      if (pendingAsset)
        return new Promise<Response>((resolve) => {
          readAsset = () => resolve(new Response(JSON.stringify(value)));
        });
      return new Response(JSON.stringify(value));
    }
    if (url === '/api/content-reviews/prepare') {
      const { publication } = JSON.parse(String(init?.body));
      preparedRevision = publication.ownerRevision;
      return new Response(JSON.stringify(fixture(publication.ownerRevision).view));
    }
    if (url.startsWith('/api/content-reviews/workspace-review-'))
      return new Response(JSON.stringify(fixture(preparedRevision).view));
    throw new Error(`unexpected read ${url}`);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('publishes the verified F138 version only after actual image pixels load, never review revision or SHA', async () => {
  await render();
  expectAbsent();
  await load();
  expectReady();
});

it.each([
  'revision',
  'publication',
  'currentSrc',
  'digest',
  'receipt',
  'sourceState',
] as const)('withdraws all coordinates despite decoded pixels when %s no longer matches the verified publication', async (mismatch) => {
  let data = fixture(2);
  await act(async () => root.render(<Observation data={data} />));
  const image = await load();
  expectReady();
  await act(async () => {
    if (mismatch === 'revision') image.src = image.src.replace('/media/2', '/media/1');
    if (mismatch === 'publication') image.src = image.src.replace('e'.repeat(64), 'f'.repeat(64));
    if (mismatch === 'currentSrc')
      Object.defineProperty(image, 'currentSrc', {
        configurable: true,
        value: image.src.replace('/media/2', '/media/1'),
      });
    if (mismatch === 'digest') data.asset = { ...data.asset, blobDigest: `sha256:${'f'.repeat(64)}` };
    if (mismatch === 'receipt') data.asset = { ...data.asset, ownerReceiptRef: 'another-receipt' };
    if (mismatch === 'sourceState') data = { ...data, view: { ...data.view, sourceState: 'changed' } };
    root.render(<Observation data={data} />);
    // Layout observation must recheck a changed currentSrc even before another native load event.
    window.dispatchEvent(new Event('resize'));
    // A new requested src can precede currentSrc/loading updates and MutationObserver delivery.
    if (['revision', 'publication', 'currentSrc'].includes(mismatch)) expectAbsent();
  });
  if (mismatch === 'revision' || mismatch === 'publication') await load(image);
  expect(image.isConnected).toBe(true);
  expect(image.naturalWidth).toBeGreaterThan(0);
  expectAbsent();
});
it('clears every coordinate when observation is disabled while decoded media stays mounted', async () => {
  const data = fixture(2);
  await act(async () => root.render(<Observation data={data} />));
  const image = await load();
  expectReady();
  await act(async () => root.render(<Observation data={data} enabled={false} />));
  expect(container.querySelector('img')).toBe(image);
  expectAbsent();
  await load(image);
  expectAbsent();
});
it('waits for the independent asset verification even when owner view and image are already available', async () => {
  pendingAsset = true;
  await render();
  await load();
  expectAbsent();
  await act(async () => {
    readAsset?.(null);
  });
  expectReady();
});
it('keeps a decoded image with zero pixels unconfirmed', async () => {
  await render();
  await load(undefined, 0);
  expectAbsent();
});
it('waits for native image decoding even after the load event and dimensions are available', async () => {
  let decoded: (() => void) | undefined;
  const decoding = new Promise<void>((resolve) => (decoded = resolve));
  mocks.decode.mockReturnValue(decoding);
  await render();
  await load();
  expectAbsent();
  await act(async () => decoded?.());
  expectReady();
});
it('ignores an aborted old decode before a same-resource mutation is delivered', async () => {
  let rejectDecode: ((reason: Error) => void) | undefined;
  mocks.decode.mockReturnValue(new Promise<void>((_resolve, reject) => (rejectDecode = reject)));
  await render();
  const image = await load();
  await act(async () => {
    Object.defineProperties(image, {
      complete: { configurable: true, value: false },
      naturalWidth: { configurable: true, value: 0 },
    });
    rejectDecode?.(new Error('old resource decode aborted'));
    image.setAttribute('src', image.src);
  });
  expectAbsent();
  mocks.decode.mockResolvedValue(undefined);
  await load(image);
  expectReady();
});
it('withdraws cached readiness when the same image resource is requested again without loaded pixels', async () => {
  await render();
  const image = await load();
  expectReady();
  await act(async () => {
    Object.defineProperties(image, {
      currentSrc: { configurable: true, value: '' },
      complete: { configurable: true, value: false },
      naturalWidth: { configurable: true, value: 0 },
      naturalHeight: { configurable: true, value: 0 },
    });
    // An identical src assignment can start a new native request on the existing element.
    image.setAttribute('src', image.src);
  });
  expectAbsent();
  await load(image);
  expectReady();
});
it('allows a readable historical publication instead of demanding the latest version', async () => {
  latest = 3;
  await render(2);
  await load();
  expectReady(2);
});
it('rejects a different publication in the owner view even when the bytes match', async () => {
  wrongView = true;
  await render();
  await load();
  expectAbsent();
});
it('withdraws all coordinates when F307 hides the surface and restores only the displayed publication', async () => {
  await render();
  await load();
  expectReady();
  await render(2, false);
  expectAbsent();
  await render();
  await load();
  expectReady();
});
it('withdraws readiness for the still-mounted hidden artwork used by the comparison layout', async () => {
  await render();
  await load();
  expectReady();
  const artwork = container.querySelector<HTMLElement>('[data-testid="workspace-review-artwork"]');
  if (!artwork) throw new Error('artwork expected');
  await act(async () => {
    artwork.style.display = 'none';
  });
  expectAbsent();
  await act(async () => {
    artwork.style.display = '';
  });
  expectReady();
});
it('does not revive the old version on a late load after navigating to a same-byte new version', async () => {
  latest = 3;
  await render();
  const old = await load();
  expectReady(2);
  await render(3);
  expectAbsent();
  await load(old);
  expectAbsent();
  await load();
  expectReady(3);
});
it('withdraws coordinates on a real media error and unmount', async () => {
  await render();
  const image = await load();
  expectReady();
  await act(async () => image.dispatchEvent(new Event('error')));
  expectAbsent();
  const originalRoot = surface();
  act(() => root.render(null));
  expect(originalRoot?.getAttribute('data-content-ready')).toBeNull();
  expect(container.querySelector('[data-content-ready]')).toBeNull();
});
it('withdraws coordinates when the existing owner invalidation read loses access', async () => {
  await render();
  await load();
  expectReady();
  const original = mocks.apiFetch.getMockImplementation();
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
    url.startsWith('/api/content-reviews/workspace-review-')
      ? new Response('{}', { status: 403 })
      : original?.(url, init),
  );
  await act(async () => window.dispatchEvent(new Event('focus')));
  expectAbsent();
});
