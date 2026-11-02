import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { writeShellLanguage } from '../../shell/shell-language';
import { CollectiveLaunchNotice } from '../CollectiveLaunchChrome';
import { useAcceptedWorkReconciliation } from '../use-accepted-work-reconciliation';

const accepted = {
  serviceInstanceId: 'svc_abcdefgh',
  collectiveId: 'col_abcdefgh',
  connectionId: 'con_abcdefgh',
  workId: 'work_abcdefgh',
  workRevision: 9,
  assignmentEventId: 'evt_assignment',
  resultEventId: 'evt_resultabcd',
  resultRevision: 1,
};

let container: HTMLDivElement;
let root: Root;
let controller: ReturnType<typeof useAcceptedWorkReconciliation>;

function Harness() {
  controller = useAcceptedWorkReconciliation();
  return <CollectiveLaunchNotice workNotice={controller.notice} />;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  writeShellLanguage('en');
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  writeShellLanguage('zh');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps public acceptance successful while a legacy owner Task still needs adoption', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ code: 'OWNER_ADOPTION_REQUIRED', error: 'raw internal owner error' }), {
      status: 409,
    }),
  );
  await act(async () => root.render(<Harness />));
  await act(async () => {
    await expect(controller.reconcile(accepted)).rejects.toThrow();
  });
  const notice = container.querySelector('[role="status"]');
  expect(notice?.textContent).toBe(
    'The public result was accepted. The original Task still needs this Café to take over its maintenance; you do not need to accept it again.',
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain('raw internal owner error');
});

it('clears the pending notice only after the exact Host reconciliation succeeds', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: 'not_admitted' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: 'closed', taskId: 'task_abcdefgh', revision: 4 })));
  await act(async () => root.render(<Harness />));
  await act(async () => {
    await expect(controller.reconcile(accepted)).rejects.toThrow();
  });
  expect(container.querySelector('[role="status"]')?.textContent).toContain('you do not need to accept it again');
  await act(async () => controller.reconcile(accepted));
  expect(container.querySelector('[role="status"]')).toBeNull();
});
