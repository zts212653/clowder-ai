import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useDemoAdmission } from '../../onboarding-demo/useDemoAdmission';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://isolated', apiFetch: vi.fn() }));
let root: Root, host: HTMLDivElement, admission: ReturnType<typeof useDemoAdmission>;
const open = vi.fn();
function Probe() {
  admission = useDemoAdmission(true, open);
  return <p>{admission.error}</p>;
}
function ExistingTeam() {
  useDemoAdmission(true, open, false);
  return null;
}
function EligibilityProbe({ eligible }: { eligible: boolean }) {
  admission = useDemoAdmission(true, open, eligible);
  return <p>{admission.error}</p>;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it('keeps personal admission readable but does not automatically offer setup to an existing team', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ userId: 'owner', version: 'collaboration-v1', status: 'not_started' })),
  );
  await act(async () => root.render(<ExistingTeam />));
  expect(open).not.toHaveBeenCalled();
});
it('does not infer a first install from an empty registry without server provenance', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({ userId: 'owner', version: 'collaboration-v1', status: 'not_started', autoEligible: false }),
  );
  await act(async () => root.render(<Probe />));
  expect(open).not.toHaveBeenCalled();
});
it('does not infer first-install eligibility from an older server response', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({ userId: 'owner', version: 'collaboration-v1', status: 'not_started' }),
  );
  await act(async () => root.render(<Probe />));
  expect(open).not.toHaveBeenCalled();
});
it.each([
  'not_started',
  'dismissed',
  'completed',
])('automatically opens only an unexecuted authenticated guide: %s', async (status) => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ userId: 'owner', version: 'collaboration-v1', status, autoEligible: true })),
  );
  await act(async () => root.render(<Probe />));
  expect(open).toHaveBeenCalledTimes(status === 'not_started' ? 1 : 0);
  expect(admission.storageScope).toBe('http://isolated:owner:collaboration-v1');
  await act(async () => root.render(<Probe />));
  expect(open).toHaveBeenCalledTimes(status === 'not_started' ? 1 : 0);
});
it('does not guess admission on failure, and retains a failed completion for explicit retry', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 503 }));
  await act(async () => root.render(<Probe />));
  expect(open).not.toHaveBeenCalled();
  await act(async () => admission.complete());
  expect(host.textContent).toContain('引导记录未保存');
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ userId: 'owner', version: 'collaboration-v1', status: 'completed' })),
  );
  await act(async () => admission.retry());
  expect(host.textContent).toBe('');
  expect(vi.mocked(apiFetch).mock.lastCall?.[1]).toMatchObject({
    method: 'PUT',
    body: JSON.stringify({ status: 'completed' }),
  });
});
it('retries a failed admission read instead of offering an inert retry', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
  await act(async () => root.render(<Probe />));
  expect(host.textContent).toContain('无法读取');
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(
      JSON.stringify({ userId: 'owner', version: 'collaboration-v1', status: 'not_started', autoEligible: true }),
    ),
  );
  await act(async () => admission.retry());
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledTimes(1);
  expect(host.textContent).toBe('');
});
it('retains completion intent after a failed save and subsequent close', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ userId: 'owner', version: 'collaboration-v1', status: 'dismissed' })),
  );
  await act(async () => root.render(<Probe />));
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
  await act(async () => admission.complete());
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ userId: 'owner', version: 'collaboration-v1', status: 'completed' })),
  );
  await act(async () => admission.dismiss());
  expect(vi.mocked(apiFetch).mock.lastCall?.[1]?.body).toBe(JSON.stringify({ status: 'completed' }));
});
it('a roster-triggered read cannot hide an unconfirmed completion save error', async () => {
  const dismissed = () =>
    new Response(JSON.stringify({ userId: 'owner', version: 'collaboration-v1', status: 'dismissed' }));
  vi.mocked(apiFetch).mockResolvedValueOnce(dismissed());
  await act(async () => root.render(<EligibilityProbe eligible={false} />));
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
  await act(async () => admission.complete());
  vi.mocked(apiFetch).mockResolvedValueOnce(dismissed());
  await act(async () => root.render(<EligibilityProbe eligible />));
  expect(host.textContent).toContain('未保存');
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ userId: 'owner', version: 'collaboration-v1', status: 'completed' })),
  );
  await act(async () => admission.retry());
  expect(vi.mocked(apiFetch).mock.lastCall?.[1]?.body).toBe(JSON.stringify({ status: 'completed' }));
  expect(host.textContent).toBe('');
});
it('serializes close and completion so an earlier acknowledgement cannot erase completion', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ userId: 'owner', version: 'collaboration-v1', status: 'dismissed' })),
  );
  await act(async () => root.render(<Probe />));
  let acknowledge!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  act(() => {
    admission.dismiss();
    admission.complete();
  });
  expect(apiFetch).toHaveBeenCalledTimes(2);
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
  await act(async () => acknowledge(new Response(JSON.stringify({ status: 'dismissed' }))));
  expect(host.textContent).toContain('未保存');
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ userId: 'owner', version: 'collaboration-v1', status: 'completed' })),
  );
  await act(async () => admission.retry());
  expect(vi.mocked(apiFetch).mock.lastCall?.[1]?.body).toBe(JSON.stringify({ status: 'completed' }));
  expect(host.textContent).toBe('');
});
