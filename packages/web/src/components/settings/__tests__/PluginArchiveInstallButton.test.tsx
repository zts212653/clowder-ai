import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { PluginArchiveInstallButton } from '../plugin-manager/PluginArchiveInstallButton';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
const onInstalled = vi.fn();

beforeEach(async () => {
  vi.mocked(apiFetch).mockReset();
  onInstalled.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<PluginArchiveInstallButton onInstalled={onInstalled} />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function select(name: string) {
  const input = container.querySelector('input');
  if (!input) throw new Error('archive input missing');
  expect(input.getAttribute('accept')).toBeNull();
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['fixture'], name)] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

it.each(['plugin.tgz', 'plugin.tar.gz'])('uploads %s through the generic Manager endpoint', async (name) => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ action: 'installed', id: 'example.plugin' }));
  await select(name);
  expect(apiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/install/upload', {
    method: 'POST',
    body: expect.any(FormData),
  });
  expect(onInstalled).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('安装成功: example.plugin');
  expect(container.textContent).not.toContain('IM Connector');
  expect(container.querySelector('a')).toBeNull();
});

it('rejects an unsupported extension before making a request', async () => {
  await select('plugin.zip');
  expect(apiFetch).not.toHaveBeenCalled();
  expect(container.textContent).toContain('请选择 .tar.gz 或 .tgz');
});

it('preserves the server rejection and does not announce installation', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ error: '归档校验失败' }, { status: 400 }));
  await select('plugin.tgz');
  expect(container.textContent).toContain('归档校验失败');
  expect(onInstalled).not.toHaveBeenCalled();
});
