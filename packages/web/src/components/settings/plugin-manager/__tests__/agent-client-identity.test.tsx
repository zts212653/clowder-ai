import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { agentClientConfigurationError, PluginAgentClientsField } from '../PluginAgentClientsField';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const fixedClient = { id: 'codeagent', name: 'CodeAgent', command: 'codeagent', startupArgs: ['--acp'] };

it('edits a standalone connection without adding clients or changing its contribution ID', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  function Harness() {
    const [value, onChange] = useState('{}');
    return (
      <>
        <PluginAgentClientsField value={value} fixedClient={fixedClient} onChange={onChange} />
        <output>{value}</output>
      </>
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<Harness />));
    expect(container.querySelector<HTMLInputElement>('[aria-label="客户端 1 命令"]')?.value).toBe('codeagent');
    expect(
      [...container.querySelectorAll('button')].some((button) => /添加|移除此客户端/.test(button.textContent!)),
    ).toBe(false);
    const field = container.querySelector<HTMLInputElement>('[aria-label="客户端 1 命令"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'D:/Agents/codeagent.exe');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(JSON.parse(container.querySelector('output')!.textContent!)).toEqual({ command: 'D:/Agents/codeagent.exe' });
    const permission = container.querySelector<HTMLSelectElement>('[aria-label="客户端 1 权限请求"]')!;
    act(() => {
      permission.value = 'auto_allow';
      permission.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const saved = container.querySelector('output')!.textContent!;
    expect(JSON.parse(saved)).toEqual({ command: 'D:/Agents/codeagent.exe', permissionPolicy: 'auto_allow' });
    act(() => root.render(<PluginAgentClientsField value={saved} fixedClient={fixedClient} onChange={vi.fn()} />));
    expect(container.querySelector<HTMLInputElement>('[aria-label="客户端 1 ID"]')?.value).toBe('codeagent');
    expect(container.querySelector<HTMLInputElement>('[aria-label="客户端 1 命令"]')?.value).toBe(
      'D:/Agents/codeagent.exe',
    );
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('validates standalone overrides without interpreting them as a client list', () => {
  expect(agentClientConfigurationError('{}', fixedClient)).toBeUndefined();
  expect(agentClientConfigurationError('{"command":"D:/Agents/codeagent.exe"}', fixedClient)).toBeUndefined();
  expect(agentClientConfigurationError('{"id":"other"}', fixedClient)).toBeTruthy();
  expect(agentClientConfigurationError('{"permissionPolicy":"unknown"}', fixedClient)).toBeTruthy();
});

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
