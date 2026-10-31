import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PluginAgentClientsField } from '../PluginAgentClientsField';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

it('creates fixed unique IDs without asking for one, and retains old IDs and launch options on rename', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const previous = {
    id: 'enterprise-codeagent',
    name: '内网',
    command: 'codeagent',
    startupArgs: ['--acp'],
    bootstrapRoot: 'D:/ACP',
  };
  function Harness() {
    const [value, onChange] = useState(JSON.stringify([previous]));
    return (
      <>
        <PluginAgentClientsField value={value} onChange={onChange} />
        <output>{value}</output>
      </>
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<Harness />));
    const oldID = container.querySelector<HTMLInputElement>('[aria-label="客户端 1 ID"]');
    expect(oldID === null || oldID.readOnly).toBe(true);
    const add = [...container.querySelectorAll('button')].find((button) => button.textContent === '添加 自定义')!;
    act(() => add.click());
    const profiles = () => JSON.parse(container.querySelector('output')!.textContent!);
    const generated = profiles()[1].id;
    expect(generated).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    const rename = (index: number, value: string) =>
      act(() => {
        const field = container.querySelector<HTMLInputElement>(`[aria-label="客户端 ${index} 名称"]`)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    rename(1, '内网改名');
    rename(2, '我的中文 client');
    expect(profiles()[0]).toEqual({ ...previous, name: '内网改名' });
    expect(profiles()[1].id).toBe(generated);
    act(() => add.click());
    expect(profiles()[2].id).not.toBe(generated);
    expect(profiles()[0].id).toBe(previous.id);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
