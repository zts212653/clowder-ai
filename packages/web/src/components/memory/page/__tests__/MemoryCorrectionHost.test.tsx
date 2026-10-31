import type { EventMemoryCorrectionProposalView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '@/components/ApprovalHost';
import { MemoryEventCorrections } from '../MemoryEventCorrections';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => null }) }));
const revision = `sha256:${'a'.repeat(64)}`;
const proposal: EventMemoryCorrectionProposalView = {
  proposalId: 'correction-a',
  status: 'pending',
  expectedRevision: revision,
  reason: 'outdated',
  suggestedPatch: { summary: '后来核实的解释' },
  sourceCatId: 'unknown-address',
  sourceThreadId: 'thread-a',
  source: { threadId: 'thread-a', messageId: 'message-a' },
  createdAt: 1,
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('locks the original correction writer under a host whose displayed read is no longer current', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <ApprovalHostContext.Provider
        value={{ ...PERMISSIVE_APPROVAL_HOST, writesLocked: true, authorizeWrite: () => false }}
      >
        <MemoryEventCorrections proposals={[proposal]} revision={revision} reread={vi.fn()} />
      </ApprovalHostContext.Provider>,
    ),
  );
  const accept = [...container.querySelectorAll('button')].find((b) => b.textContent === '接受这条建议');
  expect(accept?.disabled).toBe(true);
  await act(async () => accept?.click());
  expect(apiFetch).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('unknown-address');
});
