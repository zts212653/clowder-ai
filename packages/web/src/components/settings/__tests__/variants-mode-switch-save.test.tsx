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
            id: 'dev.clowder.mode-switch',
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
async function chooseMode(container: HTMLDivElement, value: string) {
  const select = container.querySelector('[data-testid="field-mode"]') as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function typeField(container: HTMLDivElement, key: string, value: string) {
  const input = container.querySelector(`[data-testid="field-${key}"]`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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
it('saves mode and token after switching to the hook branch and filling the token', async () => {
  await withForm(
    [mode('socket'), field('token', { kind: 'secret', required: true, sensitive: true })],
    async (container, onSave) => {
      expect(container.querySelector('[data-testid="field-token"]')).toBeNull();
      await chooseMode(container, 'hook');
      expect(container.querySelector('[data-testid="field-token"]')).not.toBeNull();
      await typeField(container, 'token', 'tok-value');
      await save(container);
      expect(onSave).toHaveBeenCalledTimes(1);
      const updates = onSave.mock.calls[0]![0] as { key: string; value: string | null }[];
      expect(updates.find((u) => u.key === 'mode')?.value).toBe('hook');
      expect(updates.find((u) => u.key === 'token')?.value).toBe('tok-value');
    },
  );
});
it('omits the inactive branch token when switching back to the socket branch', async () => {
  await withForm(
    [mode('hook'), field('token', { kind: 'secret', required: true, sensitive: true })],
    async (container, onSave) => {
      await chooseMode(container, 'socket');
      await save(container);
      expect(onSave).toHaveBeenCalledTimes(1);
      const updates = onSave.mock.calls[0]![0] as { key: string; value: string | null }[];
      expect(updates.find((u) => u.key === 'mode')?.value).toBe('socket');
      expect(updates.some((u) => u.key === 'token')).toBe(false);
    },
  );
});
