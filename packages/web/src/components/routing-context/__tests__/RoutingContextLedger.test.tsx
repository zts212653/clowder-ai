import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));

const model = {
  v: 1,
  ownerId: 'owner-1',
  observedAt: 1_800_000_000_000,
  catalogRevision: 'catalog:1',
  resolution: {
    state: 'fresh',
    inputRevisionRef: 'routing:1',
    sourceRefs: { signalEventIds: ['signal-1'], preferenceRevisionIds: [], dossierRevisions: [] },
    snapshot: {
      v: 1,
      ownerId: 'owner-1',
      observedAt: 1_800_000_000_000,
      catalogRevision: 'catalog:1',
      candidates: [],
    },
  },
  signalEvents: [
    {
      v: 1,
      eventId: 'signal-1',
      commandId: 'command-1',
      ownerId: 'owner-1',
      subjectRef: { type: 'cat', catId: 'codex-sol' },
      reasonCode: 'owner-maintenance',
      source: 'manual_cvo',
      observedAt: 1_800_000_000_000,
      validUntil: 1_800_003_600_000,
      evidenceRef: 'command:command-1',
      eventType: 'asserted',
      state: 'unavailable',
    },
  ],
  preferenceRevisions: [],
} satisfies RoutingContextReadModelV1;

vi.mock('../useRoutingContext', () => ({
  useRoutingContext: () => ({ data: model, loading: false, error: null, refresh: mocks.refresh }),
}));

describe('F293 Settings routing ledger', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders immutable history without mounting either Team writer', async () => {
    const { RoutingContextLedger } = await import('../RoutingContextLedger');
    await act(async () => root.render(<RoutingContextLedger />));

    expect(container.textContent).toContain('signal-1');
    expect(container.textContent).toContain('owner-maintenance');
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('[data-testid="routing-signal-controls"]')).toBeNull();
    expect(container.querySelector('[data-testid="routing-preference-controls"]')).toBeNull();
    expect(container.querySelector('[data-ledger-mode="read-only"]')).not.toBeNull();
  });
});
