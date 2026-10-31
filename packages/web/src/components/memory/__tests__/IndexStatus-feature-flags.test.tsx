// clowder-ai#1505 (amazing-fish): editability is opt-in, including tri-state flags.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexStatus } from '../IndexStatus';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));

function flag(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    category: 'evidence',
    defaultValue: 'off',
    currentValue: 'off',
    sensitive: false,
    description: `Description of ${name}`,
    ...extra,
  };
}

const initialFlags = [
  flag('F102_ABSTRACTIVE'),
  flag('EMBED_MODE', { runtimeEditable: false, allowedValues: ['off', 'shadow', 'on'] }),
  flag('F163_AUTHORITY_BOOST', { runtimeEditable: true, allowedValues: ['off', 'shadow', 'on'] }),
  flag('F102_RUNTIME_TOGGLE', { runtimeEditable: true }),
  flag('F102_RESTART_TOGGLE', { runtimeEditable: true, restartRequired: true }),
  flag('EVIDENCE_DOCS_ROOT', { defaultValue: './docs', currentValue: './docs' }),
];

describe('IndexStatus feature flags', () => {
  let container: HTMLDivElement;
  let root: Root;
  let flags: ReturnType<typeof flag>[];
  const onConfigChange = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    flags = initialFlags.map((item) => ({ ...item }));
    onConfigChange.mockReset();
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const { name, value } = JSON.parse(String(init.body)).updates[0];
        flags = flags.map((item) => (item.name === name ? { ...item, currentValue: value } : item));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => (path.endsWith('env-summary') ? { variables: flags } : { backend: 'sqlite', healthy: true }),
      };
    });
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async () =>
    act(async () => {
      root.render(<IndexStatus onConfigChange={onConfigChange} />);
    });
  const writes = () => apiFetch.mock.calls.filter((args) => args[1]?.method === 'PATCH');
  function row(name: string) {
    const label = [...container.querySelectorAll('#evidence-feature-flags div')].find(
      (element) => element.textContent === name,
    );
    expect(label, `row ${name} is visible`).toBeDefined();
    return label!.parentElement!.parentElement!;
  }
  async function click(name: string) {
    const button = row(name).querySelector('button');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
  }

  it.each(['F102_ABSTRACTIVE', 'EMBED_MODE'])('%s is visible without a mutation control', async (name) => {
    await render();
    expect(row(name).querySelector('button')).toBeNull();
    expect(row(name).textContent).toContain('off');
    expect(row(name).textContent).toContain('只读');
    expect(writes()).toHaveLength(0);
  });

  it('points the two read-only exceptions to their actual owners without promising env activation', async () => {
    await render();
    expect(row('EMBED_MODE').textContent).toContain('语义搜索服务');
    expect(row('EMBED_MODE').textContent).toContain('off 不会停用');
    expect(row('F102_ABSTRACTIVE').textContent).toContain('初始值');
    expect(row('F102_ABSTRACTIVE').textContent).toContain('记忆整理');
    expect(row('F102_ABSTRACTIVE').textContent).toContain('持久开关');
    expect(container.textContent).not.toContain('.env');
    expect(container.textContent).not.toContain('即时生效');
  });

  it('keeps the complete editable tri-state cycle and refresh callback', async () => {
    await render();
    for (const value of ['shadow', 'on', 'off']) {
      await click('F163_AUTHORITY_BOOST');
      expect(JSON.parse(String(writes().at(-1)?.[1].body))).toEqual({
        updates: [{ name: 'F163_AUTHORITY_BOOST', value }],
      });
      expect(row('F163_AUTHORITY_BOOST').querySelector('button')?.textContent).toBe(value);
    }
    expect(onConfigChange).toHaveBeenCalledTimes(3);
  });

  it('keeps editable on/off payloads and discloses required restarts', async () => {
    await render();
    expect(row('F102_RESTART_TOGGLE').textContent).toContain('需重启');
    for (const value of ['on', 'off']) {
      await click('F102_RUNTIME_TOGGLE');
      expect(JSON.parse(String(writes().at(-1)?.[1].body))).toEqual({
        updates: [{ name: 'F102_RUNTIME_TOGGLE', value }],
      });
    }
  });

  it.each([
    403, 400,
  ])('preserves the value and reports an HTTP %s refusal without a success callback', async (status) => {
    await render();
    apiFetch.mockResolvedValueOnce({ ok: false, status, json: async () => ({ error: 'Refused' }) });
    await click('F163_AUTHORITY_BOOST');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('没能更新这个开关');
    expect(row('F163_AUTHORITY_BOOST').querySelector('button')?.textContent).toBe('off');
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it('keeps network outcome unknown, then recovers after a confirmed save', async () => {
    await render();
    apiFetch.mockRejectedValueOnce(new Error('Connection lost'));
    await click('F163_AUTHORITY_BOOST');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('没有确认更新成功');
    expect(onConfigChange).not.toHaveBeenCalled();
    await click('F163_AUTHORITY_BOOST');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(row('F163_AUTHORITY_BOOST').querySelector('button')?.textContent).toBe('shadow');
  });
});
