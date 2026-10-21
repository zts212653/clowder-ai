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
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ pluginId: 'example.plugin', pluginInstanceId: 'pi_example' }));
  await select(name);
  expect(apiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/install/upload', {
    method: 'POST',
    body: expect.any(FormData),
  });
  expect(onInstalled).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('安装成功: example.plugin');
  expect(container.textContent).not.toContain('undefined');
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

const replacement = {
  displayName: '旧插件',
  currentVersion: '0.1.0',
  candidateVersion: '0.2.0',
  confirmation: {
    pluginId: 'example.plugin',
    pluginInstanceId: 'pi_original',
    currentPackageDigest: `sha512-${'A'.repeat(86)}==`,
    candidatePackageDigest: `sha512-${'B'.repeat(85)}A==`,
    expectedLifecycleRevision: 8,
    expectedGrantRevision: 1,
    candidateEffectiveGrants: [],
  },
};

function offered() {
  return Response.json({ code: 'ARCHIVE_REPLACEMENT_CONFIRMATION_REQUIRED', replacement }, { status: 409 });
}

async function clickButton(label: string) {
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

it('shows the actual versions and keeps the selected File for explicit confirmation', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(offered())
    .mockResolvedValueOnce(Response.json({ pluginId: 'example.plugin' }));
  await select('plugin.tgz');
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(onInstalled).not.toHaveBeenCalled();
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('0.1.0 替换为 0.2.0');
  const original = (vi.mocked(apiFetch).mock.calls[0][1]?.body as FormData).get('file');
  await clickButton('确认替换');
  expect(apiFetch).toHaveBeenCalledTimes(2);
  const body = vi.mocked(apiFetch).mock.calls[1][1]?.body as FormData;
  expect(body.get('file')).toBe(original);
  expect(JSON.parse(body.get('replacement') as string)).toEqual(replacement.confirmation);
  expect(onInstalled).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('cancelling the offer does not retry or announce installation', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(offered());
  await select('plugin.tgz');
  await clickButton('取消');
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(onInstalled).not.toHaveBeenCalled();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('input')?.disabled).toBe(false);
});

it('a stale confirmation ends the attempt without an automatic retry', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(offered())
    .mockResolvedValueOnce(
      Response.json(
        {
          code: 'STALE_ARCHIVE_REPLACEMENT',
          error: '插件已变化，请重新选择插件包',
        },
        { status: 409 },
      ),
    );
  await select('plugin.tgz');
  await clickButton('确认替换');
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(onInstalled).not.toHaveBeenCalled();
  expect(container.textContent).toContain('插件已变化');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
