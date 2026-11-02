import type { PluginManagerConfigField } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PluginManagerConfigurationSection } from '../plugin-manager/PluginManagerConfigurationSection';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '../plugin-manager/plugin-manager-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const variants: NonNullable<PluginManagerConfigField['configurationVariants']> = {
  discriminator: 'mode',
  branches: [
    { id: 'hook', when: { properties: { mode: { const: 'hook' } } }, fields: ['token'] },
    { id: 'socket', when: { properties: { mode: { const: 'socket' } } }, fields: [] },
  ],
};
const field = (
  key: string,
  rest: Pick<PluginManagerConfigField, 'kind'> & Partial<PluginManagerConfigField>,
): PluginManagerConfigField => ({
  key,
  label: key,
  required: false,
  currentValue: null,
  sensitive: false,
  configurationVariants: variants,
  ...rest,
});
const mode = (value: string | null) =>
  field('mode', {
    kind: 'select',
    required: true,
    currentValue: value,
    options: [
      { value: 'hook', label: 'Hook' },
      { value: 'socket', label: 'Socket' },
    ],
  });
async function withForm(
  fields: PluginManagerConfigField[],
  check: (container: HTMLDivElement, onSave: ReturnType<typeof vi.fn>) => Promise<void>,
) {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={{
            ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
            id: 'dev.clowder.review',
            config: 'incomplete',
            setupSteps: undefined,
            configFields: [...fields, field('name', { kind: 'string' })],
          }}
          busy={false}
          saved={false}
          validationRequest={0}
          onSaveConfig={onSave}
        />,
      ),
    );
    await check(container, onSave);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
}
async function save(container: HTMLDivElement) {
  const name = container.querySelector('[data-testid="field-name"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'changed');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '保存配置');
  expect(button).toBeDefined();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}
it('does not implicitly select first mode without a stored value or default', async () => {
  await withForm(
    [mode(null), field('token', { kind: 'secret', required: true, sensitive: true })],
    async (container, onSave) => {
      expect(container.querySelector('[data-testid="field-token"]')).toBeNull();
      expect((container.querySelector('[data-testid="field-mode"]') as HTMLSelectElement).value).toBe('');
      await save(container);
      expect(onSave).not.toHaveBeenCalled();
    },
  );
});
it('treats a cleared stored condition as a deletion when validating the draft', async () => {
  await withForm(
    [
      mode('hook'),
      field('selector', { kind: 'string', currentValue: 'enable' }),
      field('token', { kind: 'secret', sensitive: true, requiredWhen: { key: 'selector', value: 'enable' } }),
    ],
    async (container, onSave) => {
      const selector = container.querySelector('[data-testid="field-selector"]') as HTMLInputElement;
      for (const value of ['temporary', '']) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(selector, value);
          selector.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      await save(container);
      expect(onSave).toHaveBeenCalledOnce();
      expect(onSave.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'selector', value: null })]),
      );
    },
  );
});
it('uses the declared default after deleting a stored conditional value', async () => {
  await withForm(
    [
      mode('hook'),
      field('selector', { kind: 'string', currentValue: 'disable', default: 'enable' }),
      field('token', { kind: 'secret', sensitive: true, requiredWhen: { key: 'selector', value: 'enable' } }),
    ],
    async (container, onSave) => {
      const selector = container.querySelector('[data-testid="field-selector"]') as HTMLInputElement;
      for (const value of ['temporary', '']) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(selector, value);
          selector.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      await save(container);
      expect(onSave).not.toHaveBeenCalled();
    },
  );
});
it('allows saving another field while a required secret is already stored', async () => {
  await withForm(
    [mode('hook'), field('token', { kind: 'secret', sensitive: true, required: true, currentValue: '••••••' })],
    async (container, onSave) => {
      await save(container);
      expect(onSave).toHaveBeenCalledOnce();
      expect(onSave.mock.calls[0]?.[0]).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'token' })]),
      );
    },
  );
});
it('saves an edited stored secret as a new value', async () => {
  await withForm(
    [mode('hook'), field('token', { kind: 'secret', sensitive: true, required: true, currentValue: '••••••' })],
    async (container, onSave) => {
      const token = container.querySelector('[data-testid="field-token"]') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(token, 'fresh-token');
        token.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await save(container);
      expect(onSave).toHaveBeenCalledOnce();
      expect(onSave.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'token', value: 'fresh-token' })]),
      );
    },
  );
});
it('enforces boolean requiredWhen on string-valued form projection', async () => {
  await withForm(
    [
      mode('hook'),
      field('enabled', { kind: 'boolean', currentValue: 'true' }),
      field('token', { kind: 'secret', sensitive: true, requiredWhen: { key: 'enabled', value: true } }),
    ],
    async (container, onSave) => {
      await save(container);
      expect(onSave).not.toHaveBeenCalled();
    },
  );
});
it('uses requiredNow for an existing masked secret condition', async () => {
  await withForm(
    [
      mode('hook'),
      field('selector', { kind: 'secret', sensitive: true, currentValue: '••••••' }),
      field('token', {
        kind: 'secret',
        sensitive: true,
        requiredNow: true,
        requiredWhen: { key: 'selector', value: 'enable' },
      }),
    ],
    async (container, onSave) => {
      await save(container);
      expect(onSave).not.toHaveBeenCalled();
    },
  );
});
