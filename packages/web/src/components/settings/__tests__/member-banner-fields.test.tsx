import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { initialState } from '../../hub-cat-editor.model';
import { buildCatPayload } from '../../hub-cat-editor.payload';
import { MemberBannerFields } from '../members/MemberBannerFields';

it('saves a changed banner primary colour without replacing the independent secondary colour', async () => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let saved: ReturnType<typeof buildCatPayload> | undefined;
  function Editor() {
    const [form, setForm] = useState({ ...initialState(), colorPrimary: '#765843', colorSecondary: '#eadccc' });
    return (
      <>
        <MemberBannerFields
          form={form}
          t={(zh) => zh}
          patch={(change) => setForm((current) => ({ ...current, ...change }))}
        />
        <button
          type="button"
          onClick={() => {
            saved = buildCatPayload(form);
          }}
        >
          Save
        </button>
      </>
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Editor />));
    const primary = host.querySelector<HTMLInputElement>('input[type="color"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(primary, '#315c72');
      primary?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save')?.click();
    });
    expect(saved?.color).toEqual({ primary: '#315c72', secondary: '#eadccc' });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
