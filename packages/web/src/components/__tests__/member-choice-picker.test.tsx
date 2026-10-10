import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { MemberChoicePicker } from '../settings/members/MemberChoicePicker';

it('selects an opaque value, restores inheritance from the same menu and closes on Escape', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function TestPicker() {
    const [value, setValue] = useState('');
    return (
      <>
        <MemberChoicePicker
          label="模型"
          value={value}
          onChange={setValue}
          options={[
            { value: '["provider","a"]', label: 'Model A' },
            { value: 'b', label: 'Model B' },
          ]}
          inheritLabel="跟随工具"
          searchable
          allowCustom
        />
        <output>{value || 'inherited'}</output>
      </>
    );
  }
  const trigger = () => host.querySelector<HTMLButtonElement>('[role=combobox]')!;
  const option = (value: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role=option]')).find((e) => e.textContent?.includes(value))!;
  try {
    await act(async () => root.render(<TestPicker />));
    await act(async () => trigger().click());
    expect(host.querySelector('[aria-label="搜索模型"]')).toBe(document.activeElement);
    await act(async () => option('Model A').click());
    expect(host.querySelector('output')?.textContent).toBe('["provider","a"]');
    expect(document.activeElement).toBe(trigger());
    await act(async () => trigger().click());
    await act(async () => option('跟随工具').click());
    expect(host.querySelector('output')?.textContent).toBe('inherited');
    await act(async () => trigger().click());
    await act(async () =>
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
