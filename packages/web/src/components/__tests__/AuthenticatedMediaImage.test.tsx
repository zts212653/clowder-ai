import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthenticatedMediaImage } from '../AuthenticatedMediaImage';

const apiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://127.0.0.1:4300',
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const hmrId = `hmr_${'A'.repeat(32)}`;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:private-image'), revokeObjectURL: vi.fn() });
  apiFetch.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('loads HMR bytes through authenticated API and never renders the identifier as an image URL', async () => {
  const blob = new Blob(['private']);
  apiFetch.mockResolvedValue({ ok: true, blob: async () => blob });
  await act(async () =>
    root.render(<AuthenticatedMediaImage url={`hmr:${hmrId}`} alt="attachment" className="image" />),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(apiFetch).toHaveBeenCalledWith(
    `/api/media/hmr/${hmrId}`,
    expect.objectContaining({ signal: expect.anything() }),
  );
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:private-image');
  expect(container.innerHTML).not.toContain(`hmr:${hmrId}`);
  await act(async () => root.unmount());
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-image');
  root = createRoot(container);
});

it('shows a stable placeholder for denied and malformed references', async () => {
  apiFetch.mockResolvedValue({ ok: false, status: 404 });
  await act(async () =>
    root.render(<AuthenticatedMediaImage url={`hmr:${hmrId}`} alt="attachment" className="image" />),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(container.textContent).toContain('图片暂不可用');
  expect(container.querySelector('img')).toBeNull();
  apiFetch.mockClear();
  await act(async () =>
    root.render(<AuthenticatedMediaImage url="hmr:../escape" alt="attachment" className="image" />),
  );
  expect(container.textContent).toContain('图片暂不可用');
  expect(apiFetch).not.toHaveBeenCalled();
});

it('never reuses a prior HMR blob URL while a different identifier is loading', async () => {
  apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['first']) });
  apiFetch.mockImplementationOnce(() => new Promise(() => {}));
  await act(async () =>
    root.render(<AuthenticatedMediaImage url={`hmr:${hmrId}`} alt="attachment" className="image" />),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:private-image');
  await act(async () =>
    root.render(<AuthenticatedMediaImage url={`hmr:hmr_${'B'.repeat(32)}`} alt="attachment" className="image" />),
  );
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('图片加载中');
});
