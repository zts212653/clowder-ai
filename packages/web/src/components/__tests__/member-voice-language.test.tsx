import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../hub-cat-editor.model';
import { MemberAdditionalFields } from '../settings/members/MemberAdditionalFields';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

it('can restore a custom voice language after selecting a preset', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({ voices: [] }));
  function Form() {
    const [form, setForm] = useState({ ...initialState(), voiceLangCode: 'fr-custom' });
    return (
      <>
        <MemberAdditionalFields
          section="voice"
          form={form}
          patch={(change) => setForm((current) => ({ ...current, ...change }))}
          t={(zh) => zh}
          editing
          strategy={null}
          patchStrategy={() => {}}
        />
        <output>{form.voiceLangCode}</output>
      </>
    );
  }
  try {
    await act(async () => root.render(<Form />));
    const preset = host.querySelector<HTMLSelectElement>('select[aria-label="语言"]');
    if (!preset) throw Error('language presets missing');
    await act(async () => {
      preset.value = 'zh';
      preset.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelector('output')?.textContent).toBe('zh');
    const custom = Array.from(host.querySelectorAll('input')).find((input) =>
      input.closest('label')?.textContent?.includes('自定义语言代码'),
    );
    if (!custom) throw Error('custom language input missing');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(custom, 'fr-custom');
      custom.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('output')?.textContent).toBe('fr-custom');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
