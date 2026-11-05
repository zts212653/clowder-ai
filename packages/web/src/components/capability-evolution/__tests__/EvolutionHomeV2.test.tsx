import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAILBOX_NAVIGATE_EVENT } from '@/components/shell/mailbox/mailbox-navigation';
import { EvolutionPendingDecisions } from '../CapabilityEvolutionHomeV2';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { assetRef, ownerRef, programFixture } from './evolution-fixtures';

function candidate(id: string, status: 'pending' | 'approved' = 'pending'): EvolutionProgramProjection {
  const projection = structuredClone(programFixture('awaiting_approval', 8)) as EvolutionProgramProjection;
  projection.program.programId = `evolution-program:${id.padEnd(32, '0')}`;
  const change = {
    caseRef: ownerRef(`case-${id}`),
    proposalRef: { ownerFeatureId: 'F266', ownerStateRef: `eval-repair-proposal:${id}` },
    ownerAuthorizationRef: ownerRef(`authorization-${id}`),
    targetVersionRef: assetRef(`candidate-${id}`),
    status,
    ...(status === 'approved' ? { approvalRef: { ownerFeatureId: 'F246', ownerStateRef: `approval:${id}` } } : {}),
  } as const;
  projection.lineage = { cycles: [{ cycle: 1, changes: [change] }], current: change };
  return projection;
}

describe('v2 Evolution pending decisions', () => {
  let host: HTMLDivElement;
  let root: Root;
  const navigate = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    window.addEventListener(MAILBOX_NAVIGATE_EVENT, navigate);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.removeEventListener(MAILBOX_NAVIGATE_EVENT, navigate);
    navigate.mockReset();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('counts only exact open Program decisions and opens the sole proposal in Mailbox', async () => {
    await act(async () =>
      root.render(
        <EvolutionPendingDecisions programs={[candidate('one'), candidate('done', 'approved')]} readComplete={true} />,
      ),
    );
    expect(host.textContent).toContain('待判断 1');
    const button = host.querySelector('button');
    expect(button?.textContent).toContain('去待办审阅');
    await act(async () => button?.click());
    expect((navigate.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      section: 'pending',
      proposalId: 'one',
    });
  });

  it('opens the pending list without guessing one proposal when several Programs need judgment', async () => {
    await act(async () =>
      root.render(<EvolutionPendingDecisions programs={[candidate('one'), candidate('two')]} readComplete={true} />),
    );
    expect(host.textContent).toContain('待判断 2');
    await act(async () => host.querySelector('button')?.click());
    expect((navigate.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'pending' });
  });
});
