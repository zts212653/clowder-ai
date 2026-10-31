import type { ContentModificationRecord } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearModificationFocus, focusModification } from '@/components/content-review/modification-focus';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceModificationEntry } from '../WorkspaceModificationEntry';
import { workspaceReviewRequestSource } from '../workspace-modification-source';
import { mediaView } from './WorkspaceContentReviewSurface.fixture';

const landing = vi.hoisted(() => ({ props: null as null | { onClose: () => void; focusCandidateRef?: string } }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/content-review/ContentModificationLanding', () => ({
  ContentModificationLanding: (props: { onClose: () => void; focusCandidateRef?: string }) => {
    landing.props = props;
    return <output data-testid="landing">{props.focusCandidateRef ?? 'no candidate'}</output>;
  },
}));

const THREAD = 'thread-comparing';
const view = mediaView();
const record = {
  requestId: `f309-modification-${'3'.repeat(64)}`,
  ownerUserId: view.review.ownerUserId,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  progress: {},
  payload: { source: workspaceReviewRequestSource(view) },
} as unknown as ContentModificationRecord;

let root: Root;
let element: HTMLDivElement;
const onComparing = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onComparing.mockReset();
  landing.props = null;
  useChatStore.setState({ currentThreadId: THREAD, workspaceOpenRevision: 7 });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  clearModificationFocus();
  await act(async () => root.unmount());
  element.remove();
});

const render = () =>
  act(async () =>
    root.render(
      <WorkspaceModificationEntry
        view={view}
        path="cover.png"
        target={null}
        disabled={false}
        onComparing={onComparing}
      />,
    ),
  );
const ask = (candidateRef?: string) =>
  act(async () =>
    focusModification({
      record,
      ...(candidateRef ? { candidateRef } : {}),
      navigation: { threadId: THREAD, revision: 7 },
    }),
  );

it('says which navigation the Workspace is comparing for when a receipt asks for one candidate of this file', async () => {
  await render();
  await ask('candidate-v2');
  // The navigation that made the ask: a newer one is how the layout learns it is out of date.
  expect(onComparing).toHaveBeenCalledWith(7);
  expect(element.querySelector('[data-testid="landing"]')?.textContent).toBe('candidate-v2');
});

it('says there is no comparison, when the receipt only asks for the file', async () => {
  await render();
  await ask();
  expect(onComparing).toHaveBeenCalledWith(null);
  expect(onComparing).not.toHaveBeenCalledWith(7);
  expect(element.querySelector('[data-testid="landing"]')).not.toBeNull();
});

it('a file-only ask after a candidate ask ends the comparison', async () => {
  await render();
  await ask('candidate-v2');
  onComparing.mockClear();
  useChatStore.setState({ workspaceOpenRevision: 8 });
  await act(async () => focusModification({ record, navigation: { threadId: THREAD, revision: 8 } }));
  expect(onComparing).toHaveBeenCalledWith(null);
});

it('says the comparison is over when the panel is closed', async () => {
  await render();
  await ask('candidate-v2');
  onComparing.mockClear();
  await act(async () => landing.props?.onClose());
  expect(onComparing).toHaveBeenCalledWith(null);
  expect(element.querySelector('[data-testid="landing"]')).toBeNull();
});

it('does not take an ask that belongs to another file', async () => {
  await render();
  const other = structuredClone(record);
  // The object is the owner's review of one file, which is what the pending ask is matched on.
  (other.payload.source as { reviewId: string }).reviewId = `workspace-review-${'f'.repeat(64)}`;
  await act(async () =>
    focusModification({ record: other, candidateRef: 'candidate-v2', navigation: { threadId: THREAD, revision: 7 } }),
  );
  expect(onComparing).not.toHaveBeenCalled();
});
