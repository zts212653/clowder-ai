import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '@/components/ApprovalHost';
import { apiFetch } from '@/utils/api-client';
import { ScheduleMutationProposalCard } from '../ScheduleMutationProposalCard';
import { coordinate, ok, scheduleBlock, scheduleItem, scheduleProposal } from './schedule-approval.fixture';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') return ok({ proposalId: 'different-proposal', status: 'approved' });
    if (String(path) === '/api/session') return ok({ userId: 'owner-1' });
    if (String(path).includes('/approval-hub/pending')) return ok({ items: [scheduleItem()] });
    if (String(path) === '/api/schedule/templates')
      return ok({
        templates: [
          {
            templateId: 'private-template',
            label: 'Evidence reminder',
            paramSchema: { text: { description: 'Original request' } },
          },
        ],
      });
    if (String(path) === '/api/threads/destination')
      return ok({ id: 'destination', title: 'Original discussion', projectPath: 'default' });
    return ok({ proposal: scheduleProposal() });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
});
const approve = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('批准并创建'));
it('does not write while the original card host locks writes', async () => {
  await act(async () =>
    root.render(
      <ApprovalHostContext.Provider
        value={{ ...PERMISSIVE_APPROVAL_HOST, writesLocked: true, authorizeWrite: () => false }}
      >
        <ScheduleMutationProposalCard block={scheduleBlock} coordinate={coordinate} />
      </ApprovalHostContext.Provider>,
    ),
  );
  await act(async () => approve()?.click());
  expect(vi.mocked(apiFetch).mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
});
it('does not turn another proposal receipt into an approved original schedule', async () => {
  await act(async () => root.render(<ScheduleMutationProposalCard block={scheduleBlock} coordinate={coordinate} />));
  expect(approve()).toBeDefined();
  await act(async () => approve()?.click());
  expect(container.textContent).not.toContain('已批准');
  expect(container.querySelector('[data-testid="schedule-approval-result"]')).toBeNull();
  expect(container.textContent).toContain('重新读取');
});
