import type { ArtifactReviewRound, ArtifactReviewView, ContentModificationRequestView } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const landing = vi.hoisted(() => ({ props: null as null | { onRequestKnown?: (request: unknown) => void } }));
vi.mock('../ContentModificationLanding', () => ({
  ContentModificationLanding: (props: typeof landing.props) => {
    landing.props = props;
    return null;
  },
}));

import { ArtifactModificationEntry } from '../ArtifactModificationEntry';

let root: Root;
let container: HTMLDivElement;
const region = { kind: 'image-region' as const, x: 630, y: 150, width: 120, height: 80 };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  landing.props = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const view = {
  review: {
    reviewId: 'review',
    revision: 3,
    title: '猫咖秋日封面',
    task: { taskId: 'task', threadId: 'thread', ownerUserId: 'operator' },
  },
  authority: { taskRevision: 1, ownerCatId: 'codex-astra' },
} as unknown as ArtifactReviewView;
const round = { number: 1, asset: { mediaType: 'image/png' } } as unknown as ArtifactReviewRound;

async function openWith(onRegionHandedOff: () => void) {
  await act(async () =>
    root.render(
      createElement(ArtifactModificationEntry, {
        view,
        round,
        draft: { body: '', anchor: region },
        disabled: false,
        onRegionHandedOff,
      }),
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="content-modification-entry"]')?.click(),
  );
  expect(landing.props?.onRequestKnown).toBeTypeOf('function');
}

const known = (intent: Record<string, unknown>) =>
  ({ record: { payload: { intent: { body: '', ...intent } } } }) as unknown as ContentModificationRequestView;

it('releases the canvas region once a recorded erase request carries it', async () => {
  const handedOff = vi.fn();
  await openWith(handedOff);
  await act(async () =>
    landing.props?.onRequestKnown?.(
      known({
        imageEdit: { kind: 'erase-region', region: { x: 630, y: 150, width: 120, height: 80 } },
        selection: region,
      }),
    ),
  );
  expect(handedOff).toHaveBeenCalledTimes(1);
});

it('keeps the region for other requests or another selection', async () => {
  const handedOff = vi.fn();
  await openWith(handedOff);
  await act(async () => {
    landing.props?.onRequestKnown?.(known({ imageEdit: { kind: 'aspect-ratio', ratio: '9:16' }, selection: region }));
    landing.props?.onRequestKnown?.(
      known({
        imageEdit: { kind: 'erase-region', region: { x: 1, y: 1, width: 2, height: 2 } },
        selection: { ...region, x: 1, y: 1, width: 2, height: 2 },
      }),
    );
  });
  expect(handedOff).not.toHaveBeenCalled();
});
