import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PluginAgentClientsField } from '../PluginAgentClientsField';

let container: HTMLDivElement;
let root: Root;
function Harness() {
  const [value, onChange] = useState(
    JSON.stringify([{ id: 'custom', name: 'Custom', command: 'codeagent', startupArgs: ['--acp'] }]),
  );
  return (
    <>
      <PluginAgentClientsField value={value} onChange={onChange} />
      <output>{value}</output>
    </>
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(apiFetch).mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent === text);
  expect(found).toBeDefined();
  return found!;
}
function changeDirectory(value: string) {
  const field = container.querySelector<HTMLInputElement>('[aria-label="客户端 1 引导目录"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('checks an automatic strict candidate and lets the owner save or clear that root without changing argv', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, root: 'D:/TrustedACP' })));
  expect(container.querySelector('[aria-label="客户端 1 引导目录"]')).not.toBeNull();
  await act(async () => {
    button('检查引导目录').click();
  });
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/agent-providers/bootstrap-check',
    expect.objectContaining({ method: 'POST', body: '{}' }),
  );
  expect(container.textContent).toContain('D:/TrustedACP');
  act(() => button('使用此目录').click());
  expect(JSON.parse(container.querySelector('output')!.textContent!)[0]).toMatchObject({
    bootstrapRoot: 'D:/TrustedACP',
    command: 'codeagent',
    startupArgs: ['--acp'],
  });
  changeDirectory('');
  expect(JSON.parse(container.querySelector('output')!.textContent!)[0]).not.toHaveProperty('bootstrapRoot');
});
it('keeps a failed check visible and permits retry without replacing the saved configuration', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'PARENT_OWNER: unsafe ancestor' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, root: 'D:/TrustedACP' })));
  changeDirectory('D:/TrustedACP');
  await act(async () => {
    button('检查引导目录').click();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('PARENT_OWNER');
  expect(container.textContent).toContain('未启动客户端');
  expect(JSON.parse(container.querySelector('output')!.textContent!)[0].bootstrapRoot).toBe('D:/TrustedACP');
  await act(async () => {
    button('检查引导目录').click();
  });
  expect(container.querySelector('[role="status"]')?.textContent).toContain('严格检查通过');
});

it('never describes a compatibility check as fully trusted ancestry', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        root: 'D:/PrivateACP',
        trustMode: 'trusted-host',
      }),
    ),
  );
  await act(async () => {
    button('检查引导目录').click();
  });
  expect(container.querySelector('[role="status"]')?.textContent).toContain('兼容模式检查通过');
  expect(container.querySelector('[role="status"]')?.textContent).toContain('已跳过祖先信任校验');
  expect(container.textContent).not.toContain('严格检查通过');
});
